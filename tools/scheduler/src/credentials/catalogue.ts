import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validate } from "../schema/validate.ts";
import { listProfiles } from "../profiles/resolve.ts";

/** The probes `src/credentials/check.ts` implements; a `{ builtin }` check must name one. */
export const PROBE_NAMES = ["github-app", "telegram-get-me"] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export interface CatalogueEntry {
  name: string;
  provider: string;
  purpose: string;
  access: string[];
  used_by: string[];
  wrapper: "none" | { command: string; env: string };
  expiry: "none" | "index" | { probe: string };
  /** a command through the wrapper (entry with a wrapper) or a scheduler probe (`wrapper: none`), spec 069 AC-1 */
  check: string | { builtin: ProbeName };
  renew: "none" | "manual" | { command: string };
  setup: string[];
}

export function standingAgentNames(agentsDir: string): string[] {
  return readdirSync(join(agentsDir, "standing"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

export function loadCatalogue(path: string, known: { profiles: string[]; standingAgents: string[] }): CatalogueEntry[] {
  const fail = (entry: string, rule: string): never => {
    throw new Error(`credential catalogue ${path}: ${entry}: ${rule}`);
  };
  const data = parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(data)) return fail("file", "must be a list of entries");
  // Name the entry and the rule for the first schema failure per entry, as the other loaders do.
  data.forEach((raw, i) => {
    const label = typeof raw?.name === "string" ? raw.name : `entry ${i}`;
    const v = validate("credential-catalogue", [raw]);
    if (!v.ok) fail(label, `invalid: ${v.errors.join("; ")}`);
  });
  const entries = data as CatalogueEntry[];
  const names = new Set<string>();
  const wrapped = new Map<string, string>();
  for (const e of entries) {
    if (names.has(e.name)) fail(e.name, "duplicate name");
    names.add(e.name);
    if (e.wrapper !== "none") {
      const other = wrapped.get(e.wrapper.command);
      if (other) fail(e.name, `wrapper command ${e.wrapper.command} is already wrapped by ${other}`);
      wrapped.set(e.wrapper.command, e.name);
      if (typeof e.check !== "string") fail(e.name, "an entry with a wrapper has a command string as its check, not a builtin");
    } else if (typeof e.check === "string") {
      fail(e.name, "a `wrapper: none` entry's check is { builtin: <name> }, a probe the scheduler runs, not a command string");
    }
    if (typeof e.check !== "string" && !(PROBE_NAMES as readonly string[]).includes(e.check.builtin)) fail(e.name, `builtin ${e.check.builtin} is not implemented`);
    for (const u of e.used_by) {
      if (u === "scheduler") {
        if (e.wrapper !== "none") fail(e.name, "used_by scheduler is only valid for a `wrapper: none` entry");
      } else if (!known.profiles.includes(u) && !known.standingAgents.includes(u)) fail(e.name, `used_by ${u} is neither a profile nor a standing agent`);
    }
  }
  return entries;
}

export function loadCatalogueFor(agentsDir: string): CatalogueEntry[] {
  return loadCatalogue(join(agentsDir, "credentials.yaml"), { profiles: listProfiles(agentsDir), standingAgents: standingAgentNames(agentsDir) });
}
