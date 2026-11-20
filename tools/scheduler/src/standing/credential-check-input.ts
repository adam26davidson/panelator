import type { CredentialEntry } from "../credentials/catalogue.ts";
import { runCheck, type CheckContext, type CheckResult } from "../credentials/check.ts";
import type { ScopeResult } from "../contacts/scope.ts";
import { readParties } from "../contacts/gate.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingEvent } from "./state.ts";

const DAY_MS = 86_400_000;

/** Spec 099 AC-12: the pre-run (`runCheck` over every entry, then the scope check) and the input built from it. No secret is read into it. */
export async function buildCredentialCheckInput(d: { paths: StatePaths; catalogue: Record<string, CredentialEntry>; probe: CheckContext; warnDays: number; scope: () => Promise<ScopeResult>; now: Date }, events: StandingEvent[], since: string | null) {
  const checks: Record<string, CheckResult> = {};
  for (const e of Object.values(d.catalogue)) checks[e.name] = await runCheck(e, d.probe).catch((err): CheckResult => ({ status: "failed", reason: (err as Error).message }));
  const scope = await d.scope().catch((e): ScopeResult => ({ status: "failed", reason: `scope check failed: ${(e as Error).message}` }));
  const index = await d.probe.store.readIndex();
  const entries = Object.values(d.catalogue).map((e) => {
    const ix = index[e.name];
    return {
      name: e.name, provider: e.provider, purpose: e.purpose, access: e.access, used_by: e.used_by, set: Boolean(ix),
      expiry: typeof e.expiry === "string" ? e.expiry : "probe", expires_at: ix?.expires_at ?? null,
      days_left: ix?.expires_at ? Math.floor((Date.parse(ix.expires_at) - d.now.getTime()) / DAY_MS) : null,
      last_check: ix?.last_check ?? null, renew: e.renew === "none" || e.renew === "manual" ? e.renew : "command", setup: e.setup,
    };
  });
  return { since, events, warn_days: d.warnDays, entries, checks, scope, parties: await readParties(d.paths) };
}
