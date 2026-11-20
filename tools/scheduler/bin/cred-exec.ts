#!/usr/bin/env node
// Spec 099 AC-2: run <command> with the named credential's secret in the child's environment only.
// Loads the configuration, the catalogue entry and the store and nothing else: no registry, no state
// directories, no agent state. Writes nothing; errors go to stderr without the secret.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { loadCatalogue, profileNames } from "../src/credentials/catalogue.ts";
import { storeFromConfig } from "../src/credentials/store.ts";

const die = (m: string): never => { console.error(`cred-exec: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
let configPath = defaultConfigPath;
if (args[0] === "--config") { configPath = args[1] ?? die("--config needs a path"); args.splice(0, 2); }
let cataloguePath = join(agentsDir, "credentials.yaml");
if (args[0] === "--catalogue") { cataloguePath = args[1] ?? die("--catalogue needs a path"); args.splice(0, 2); }
const name = args[0];
const sep = args.indexOf("--");
if (!name || sep !== 1 || !args[2]) die("usage: cred-exec.ts [--config path] <name> -- <command> [args]");
const [command, ...rest] = args.slice(2) as [string, ...string[]];
try {
  const cfg = loadConfig(configPath);
  const standing = join(agentsDir, "standing");
  const agents = existsSync(standing) ? readdirSync(standing).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];
  const entry = loadCatalogue(cataloguePath, { profiles: profileNames(agentsDir), agents })[name];
  if (!entry || entry.wrapper === "none") die(`${name} is not a wrapped credential`);
  const wrapper = entry.wrapper as { command: string; env: string };
  const secret = await storeFromConfig(cfg).readSecret(name);
  const shimsDir = process.env.PANELATOR_SHIM_DIR;
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const path = (process.env.PATH ?? "").split(delimiter).filter((p) => !(shimsDir && p && real(p) === real(shimsDir)));
  const found = path.map((p) => join(p || ".", command)).find((f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } });
  if (!found) die(`${command} not found on PATH`);
  const child = spawn(found as string, rest, { stdio: "inherit", env: { ...process.env, PATH: path.join(delimiter), [wrapper.env]: secret, PANELATOR_SHIM_DIR: undefined } });
  child.on("error", (e) => die(`cannot run ${command}: ${e.message}`));
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 + (sigNum(signal) ?? 0) : 1)));
} catch (e) {
  die((e as Error).message);
}
function sigNum(s: NodeJS.Signals): number | undefined { return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[s]; }
