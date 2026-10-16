#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../src/adapters/index.ts";
import { agentsDir, defaultConfigPath, loadConfig, repoRoot } from "../src/config.ts";
import { createAppClient } from "../src/github/auth.ts";
import { GitHubClient } from "../src/github/client.ts";
import { LogNotifier } from "../src/notify/log.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { fastForwardMain, fetchOrigin } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { ServiceLog } from "../src/service/log.ts";
import { Scheduler } from "../src/service/loop.ts";
import { systemdStopUnit, systemdUnitActive } from "../src/service/units.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

const cfg = loadConfig(flag("--config") ?? defaultConfigPath);
const paths = statePaths(cfg.state_dir);
await ensureStateDirs(paths);
const serviceLog = new ServiceLog(paths.serviceLog);
const binDir = dirname(fileURLToPath(import.meta.url));

/** I7: a configuration error the service cannot recover from by restarting; the unit's RestartPreventExitStatus=78 stops the loop. */
function fail(reason: string): never {
  serviceLog.write({ kind: "config-error", reason });
  console.error(`panelator-scheduler: ${reason}`);
  process.exit(78);
}

if (cfg.app.id === 0 || cfg.app.installation_id === 0) fail("GitHub App ids not set in agents/scheduler.yaml");
let privateKey: string;
try {
  privateKey = readFileSync(cfg.app.private_key_path, "utf8");
} catch (e) {
  fail(`cannot read the GitHub App private key at ${cfg.app.private_key_path}: ${(e as Error).message}`);
}
let branch = "";
try {
  branch = execFileSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  /* detached HEAD */
}
if (branch !== "main") fail("service checkout must be on main");
// Stages push with the App token through the credential helper, which only applies to https remotes.
const origin = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
if (!origin.startsWith("https://")) fail(`origin must be an https URL (stages cannot push over SSH); got ${origin}`);

const app = createAppClient(cfg.app, privateKey);
const token = await app.refreshTokenFile(paths);
const botLogin = await app.botLogin();
if (has("--check-auth")) {
  console.log(`bot ${botLogin}, token expires ${token.expires_at}`);
  process.exit(0);
}
const stopRefresh = app.startTokenRefresh(paths);
const gh = new GitHubClient(app.octokit, cfg.repo);

let exitCode = 0;
let restartRequested = false;
const scheduler: Scheduler = new Scheduler({
  cfg, paths, gh, notifier: rateLimited(new LogNotifier(paths.serviceLog), cfg.notify_rate_limit_hours),
  stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: repoRoot, binDir,
  adapterFor: (h) => adapterFor(h), systemdScope: cfg.systemd.scope, now: () => new Date(),
  unitActive: (unit) => systemdUnitActive(unit, { enabled: cfg.systemd.scope }),
  stopUnit: (unit) => systemdStopUnit(unit, { enabled: cfg.systemd.scope }),
  refreshToken: () => app.refreshTokenFile(paths).then(() => {}),
  log: (rec) => serviceLog.write(rec), fetchOrigin: () => fetchOrigin(repoRoot),
  botLogin, serviceLog, inhibitor: new SleepInhibitor({ enabled: cfg.systemd.inhibit }),
  fastForward: () => fastForwardMain(repoRoot), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
  // Called on every idle tick while a restart is pending; only the first call acts.
  // The process exits 75 (EX_TEMPFAIL) once run() returns, so Restart=on-failure restarts it.
  requestRestart: () => {
    if (restartRequested) return;
    restartRequested = true;
    serviceLog.write({ kind: "restart", reason: "tools/scheduler or agents changed on main" });
    exitCode = 75;
    stopRefresh();
    scheduler.stop("restart");
  },
});

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => scheduler.stop(sig));

if (has("--once")) {
  const info = await scheduler.tick();
  console.log(JSON.stringify(info));
  while (scheduler.active > 0) await new Promise((r) => setTimeout(r, 1000));
  scheduler.stop("once");
}
await scheduler.run();
stopRefresh();
process.exit(exitCode);
