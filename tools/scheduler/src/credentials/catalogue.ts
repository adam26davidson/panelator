import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateSchema } from "../standing/registry.ts";

export interface CatalogueEntry {
  name: string;
  provider: string;
  purpose: string;
  access: string[];
  used_by: string[];
  wrapper: "none" | { command: string; env: string };
  expiry: "none" | "index" | { probe: string };
  check: string;
  renew: "none" | "manual" | { command: string };
  setup: string[];
}
export type Catalogue = Record<string, CatalogueEntry>;

/**
 * Spec 030 AC-2: loads agents/credentials.yaml. Unknown or missing keys fail through the schema; the
 * cross-entry rules (one wrapper command per entry, `used_by` naming real profiles and agents) are here.
 * `provider: aws` is rejected until the follow-up spec adds src/aws/cli.ts, the one place that spawns `aws`.
 */
export function parseCatalogue(text: string, known: { profiles: readonly string[]; agents: readonly string[] }): Catalogue {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const v = validateSchema("credential-catalogue", raw);
  if (!v.ok) throw new Error(`credential catalogue: ${v.errors.join("; ")}`);
  const out: Catalogue = {};
  const wrapped = new Map<string, string>();
  for (const [name, e] of Object.entries(raw) as [string, Omit<CatalogueEntry, "name">][]) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`credential catalogue: invalid name ${name}`);
    if (e.provider === "aws") throw new Error(`credential catalogue: ${name}: provider aws needs src/aws/cli.ts, which is not built yet`);
    if (e.wrapper !== "none") {
      const prior = wrapped.get(e.wrapper.command);
      if (prior) throw new Error(`credential catalogue: ${name}: wrapper command ${e.wrapper.command} is already wrapped by ${prior}`);
      wrapped.set(e.wrapper.command, name);
    }
    for (const u of e.used_by) if (!known.profiles.includes(u) && !known.agents.includes(u) && u !== "scheduler") throw new Error(`credential catalogue: ${name}: used_by names unknown profile or agent ${u}`);
    out[name] = { name, ...e };
  }
  return out;
}

export function loadCatalogue(path: string, known: { profiles: readonly string[]; agents: readonly string[] }): Catalogue {
  return parseCatalogue(readFileSync(path, "utf8"), known);
}

/** A list of names a profile or agent asks for; every one must be in the catalogue. */
export function checkCredentialNames(catalogue: Catalogue, names: readonly string[], who: string): void {
  for (const n of names) if (!catalogue[n]) throw new Error(`${who}: credential ${n} is not in the catalogue`);
}
