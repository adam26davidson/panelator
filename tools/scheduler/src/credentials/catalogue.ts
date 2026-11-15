import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validate } from "../schema/validate.ts";

export const BUILTINS = ["github-app", "telegram-get-me"] as const;
export type Builtin = (typeof BUILTINS)[number];

export interface CredentialEntry {
  name: string;
  provider: string;
  purpose: string;
  access: string[];
  used_by: string[];
  wrapper: "none" | { command: string; env: string };
  expiry: "none" | "index" | { probe: string };
  check: string | { builtin: Builtin };
  renew: "none" | "manual" | { command: string };
  setup: string[];
}

/** Spec 030 AC-2 as amended by spec 069 AC-1 and AC-8. `known` names the profiles and standing agents a `used_by` may name. */
export function loadCatalogue(path: string, known: { profiles: string[]; agents: string[] }): Record<string, CredentialEntry> {
  const data = parse(readFileSync(path, "utf8")) as unknown;
  const v = validate("credential-catalogue", data);
  if (!v.ok) {
    const first = v.errors[0] ?? "invalid";
    const m = /^\/(\d+)/.exec(first);
    const entry = m && Array.isArray(data) ? (data[Number(m[1])] as { name?: string } | undefined)?.name : undefined;
    throw new Error(`${path}: ${entry ?? "catalogue"}: ${v.errors.join("; ")}`);
  }
  const entries = data as CredentialEntry[];
  const out: Record<string, CredentialEntry> = {};
  const wrapped = new Map<string, string>();
  for (const e of entries) {
    const fail = (rule: string): never => { throw new Error(`${path}: ${e.name}: ${rule}`); };
    if (out[e.name]) fail("duplicate entry name");
    const isBuiltin = typeof e.check !== "string";
    if (e.wrapper === "none" && !isBuiltin) fail("a wrapper: none entry's check must be { builtin: <name> }, a probe the scheduler runs");
    if (e.wrapper !== "none" && isBuiltin) fail("an entry with a wrapper must have a command check, not a builtin");
    if (typeof e.check !== "string" && !(BUILTINS as readonly string[]).includes(e.check.builtin)) fail(`builtin ${e.check.builtin} is not implemented`);
    if (e.wrapper !== "none") {
      const other = wrapped.get(e.wrapper.command);
      if (other) fail(`wrapper command ${e.wrapper.command} is already wrapped by ${other}`);
      wrapped.set(e.wrapper.command, e.name);
    }
    for (const u of e.used_by) {
      if (u === "scheduler") { if (e.wrapper !== "none") fail("used_by scheduler is only for a wrapper: none entry"); }
      else if (!known.profiles.includes(u) && !known.agents.includes(u)) fail(`used_by names ${u}, which is no profile or standing agent`);
    }
    out[e.name] = e;
  }
  return out;
}

export function profileNames(agentsDir: string): string[] {
  return readdirSync(join(agentsDir, "profiles")).filter((d) => existsSync(join(agentsDir, "profiles", d, "profile.yaml")));
}
