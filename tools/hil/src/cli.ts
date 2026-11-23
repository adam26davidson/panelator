// Commands: start, run, complete-failed, restore. The workflow invokes this file with node directly.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { completeCheck, createCheck, type CheckApi } from "./check.ts";
import { Log } from "./board.ts";
import { loadConfig } from "./config.ts";
import { dockerHardware } from "./docker.ts";
import { cacheDir, readLastGood } from "./last-good.ts";
import { realClock, type Clock } from "./lock.ts";
import { findPort } from "./port.ts";
import { restoreLastGood, type Hardware } from "./restore.ts";
import { emptyBoard, schemaErrors, type HilResult } from "./result.ts";
import { deriveKind, runHil } from "./run.ts";

export interface CliDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  hardware: Pick<Hardware, "flasher" | "serial">;
  clock: Clock;
  out: (line: string) => void;
  listPorts?: () => string[];
  portExists?: (path: string) => boolean;
  isAlive?: (pid: number) => boolean;
}

const OPTIONS = {
  "check-name": { type: "string", default: "hil" },
  sha: { type: "string" },
  soak: { type: "boolean", default: false },
  "build-dir": { type: "string" },
  "build-failed": { type: "boolean", default: false },
  result: { type: "string", default: "hil-result.json" },
  state: { type: "string", default: "check-run.json" },
} as const;

function need(env: CliDeps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function api(deps: CliDeps): CheckApi {
  return {
    fetch: deps.fetch,
    apiUrl: deps.env.GITHUB_API_URL || "https://api.github.com",
    repo: need(deps.env, "GITHUB_REPOSITORY"),
    token: need(deps.env, "GITHUB_TOKEN"),
  };
}

function harnessFailure(sha: string, kind: HilResult["kind"], runId: number, message: string): HilResult {
  return {
    outcome: "fail", kind, sha, run_id: runId, board: emptyBoard("ok"),
    tests: [{ name: "harness", status: "fail", duration_ms: 0, message }], reason: message, log: "",
  };
}

async function checkId(deps: CliDeps, statePath: string, name: string, sha: string): Promise<number> {
  if (existsSync(statePath)) return (JSON.parse(readFileSync(statePath, "utf8")) as { id: number }).id;
  const id = await createCheck(api(deps), name, sha);
  writeFileSync(statePath, JSON.stringify({ id, name, sha }));
  return id;
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false });
  const env = deps.env;
  const runId = Number(env.GITHUB_RUN_ID ?? 0);
  const kind = deriveKind(env.GITHUB_EVENT_NAME ?? "", env.GITHUB_REF ?? "", values.soak);
  const sha = values.sha || env.GITHUB_SHA || "";
  const config = loadConfig();
  const ports = {
    env,
    list: deps.listPorts ?? (() => readdirSync("/dev/serial/by-id")),
    exists: deps.portExists ?? existsSync,
    prefixes: config.port_prefixes,
  };

  if (command === "start") {
    const id = await createCheck(api(deps), values["check-name"], sha);
    writeFileSync(values.state, JSON.stringify({ id, name: values["check-name"], sha }));
    deps.out(`check run ${id} started on ${sha}`);
    return 0;
  }

  if (command === "run") {
    const id = await checkId(deps, values.state, values["check-name"], sha);
    const runUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`;
    let result: HilResult;
    try {
      result = await runHil(
        { kind, sha, runId, buildDir: values["build-dir"] ?? null, ...(values["build-failed"] ? { buildFailed: { runUrl } } : {}) },
        {
          ...deps.hardware,
          clock: deps.clock,
          config,
          cache: cacheDir(env),
          ports,
          isAlive: deps.isAlive,
          writeResult: (r) => {
            const errors = schemaErrors(r);
            if (errors) throw new Error(`the result does not validate against hil-result.json: ${errors}`);
            writeFileSync(values.result, JSON.stringify(r));
          },
        },
      );
    } catch (e) {
      result = harnessFailure(sha, kind, runId, e instanceof Error ? e.message : String(e));
      writeFileSync(values.result, JSON.stringify(result));
    }
    await completeCheck(api(deps), id, result);
    deps.out(`hil: ${result.outcome}`);
    return result.outcome === "pass" ? 0 : 1;
  }

  if (command === "complete-failed") {
    if (existsSync(values.result)) return 0;
    const id = await checkId(deps, values.state, values["check-name"], sha);
    const result = harnessFailure(sha, kind, runId, "the harness wrote no hil-result.json");
    writeFileSync(values.result, JSON.stringify(result));
    await completeCheck(api(deps), id, result);
    deps.out("hil: fail (the harness wrote no result)");
    return 1;
  }

  if (command === "restore") {
    const lastGood = readLastGood(cacheDir(env));
    if (!lastGood) {
      deps.out("restore failed: no last-good image in the cache");
      return 1;
    }
    const port = findPort(ports);
    if (!port.found) {
      deps.out(`restore failed: no port: ${port.reason}`);
      return 1;
    }
    const r = await restoreLastGood({ ...deps.hardware, clock: deps.clock, config }, port.path, lastGood, new Log(), false);
    if (!r.ok) {
      deps.out(`restore failed: ${r.why === "flash-failed" ? "the flash failed" : "no boot banner"}: ${r.message}`);
      return 1;
    }
    deps.out(`restored: ${r.banner.sha}`);
    return 0;
  }

  deps.out("usage: cli.ts start|run|complete-failed|restore [--check-name N] [--sha S] [--soak] [--build-dir D] [--build-failed]");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2), {
    env: process.env,
    fetch,
    hardware: dockerHardware(process.env),
    clock: realClock,
    out: (line) => console.log(line),
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
