import { exact, type ActionKind } from "./index.ts";
import { runCheck } from "../credentials/check.ts";
import { runThroughShim } from "../credentials/shims.ts";

/** Spec 099 AC-13: `renew_credential { name }`; the command runs through the entry's shim, then spec 069's `runCheck`. */
export const renewCredentialKind: ActionKind = {
  changesMode: false,
  async check(a, c) {
    exact(a, ["name"]);
    return c.credentials?.catalogue[String(a.name)] ? null : `unknown credential ${a.name}`;
  },
  async apply(a, c) {
    const cr = c.credentials!;
    const entry = cr.catalogue[String(a.name)]!;
    const fail = (reason: string): never => { cr.onRenewFailure?.(entry.name, reason); throw new Error(reason); };
    if (entry.renew === "none" || entry.renew === "manual") return fail(`${entry.name} is renewed by hand (renew: ${entry.renew})`);
    if (!cr.shim) return fail("no shim directory for this run");
    const run = await runThroughShim(entry, entry.renew.command.split(/\s+/), { ...cr.shim, timeoutMs: 600_000 });
    if (run.code !== 0) return fail(`renew command failed${run.code === null ? "" : ` (exit ${run.code})`}: ${run.output}`);
    const result = await runCheck(entry, cr.probe);
    cr.onResult?.(entry.name, result);
    if (result.status === "failed") return fail(`check failed after renewal: ${result.reason}`);
    // `skipped` is a command check spec 069 has not built yet: the renew command exited 0, so the probe still records the new expiry.
    if (typeof entry.expiry === "object") {
      const probe = await runThroughShim(entry, entry.expiry.probe.split(/\s+/), { ...cr.shim, timeoutMs: 60_000 });
      const at = probe.output.split("\n").pop()?.trim() ?? "";
      if (probe.code === 0 && !Number.isNaN(Date.parse(at))) await cr.store.writeExpiry(entry.name, new Date(at).toISOString());
    }
    return { undo: null };
  },
};
