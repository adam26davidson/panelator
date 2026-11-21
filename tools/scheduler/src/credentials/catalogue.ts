import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { schemaDir, validate, type SchemaName, type Validation } from "../schema/validate.ts";

const addFormats = addFormatsModule.default;

/** The schemas spec 099 adds under schemas/scheduler/. They are registered here, beside the catalogue they describe, because
 * schema/validate.ts's closed name list is outside spec 099's file scope; `validateSchema` serves both lists. */
export const SPEC_099_SCHEMAS = ["profile", "contacts", "credential-check-input", "credential-check-result"] as const;
export type Spec099Schema = (typeof SPEC_099_SCHEMAS)[number];

let extra: Ajv2020 | null = null;
function extraAjv(): Ajv2020 {
  if (extra) return extra;
  extra = new Ajv2020({ allErrors: true, strict: true });
  addFormats(extra);
  // credential-check-result.json extends standing-result.json, which refers to action.json and finding.json.
  for (const name of [...SPEC_099_SCHEMAS, "standing-result", "action", "finding"]) {
    extra.addSchema(JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8")), `${name}.json`);
  }
  return extra;
}

/** `validate` for every schema name: spec 099's four from the registry above, the rest from schema/validate.ts. */
export function validateSchema(name: string, data: unknown): Validation {
  if (!(SPEC_099_SCHEMAS as readonly string[]).includes(name)) return validate(name as SchemaName, data);
  const fn = extraAjv().getSchema(`${name}.json`);
  if (!fn) throw new Error(`unknown schema: ${name}`);
  if (fn(data)) return { ok: true };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${Object.keys(e.params ?? {}).length ? " " + JSON.stringify(e.params) : ""}`.trim());
  return { ok: false, errors };
}

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
      if (!/^[a-z][a-z0-9._-]*$/.test(e.wrapper.command)) fail(`wrapper command ${e.wrapper.command} must match ^[a-z][a-z0-9._-]*$ (a bare command name, no slash)`);
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

/** Spec 099 AC-1: every name a profile or standing definition lists must be in the catalogue. */
export function checkCredentialNames(catalogue: Record<string, CredentialEntry>, lists: { profiles: Record<string, string[]>; agents: Record<string, string[]> }): void {
  for (const [kind, group] of [["profile", lists.profiles], ["agent", lists.agents]] as const)
    for (const [who, names] of Object.entries(group))
      for (const n of names) if (!catalogue[n]) throw new Error(`${kind} ${who}: credentials names ${n}, which is not in the catalogue`);
}
