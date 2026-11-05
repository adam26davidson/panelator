import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
import { checkAll, daysLeft, type CredDeps } from "../credentials/check.ts";
import { readParties } from "../contacts/gate.ts";
import type { StandingEvent } from "./state.ts";

/** Spec 030 AC-13: the catalogue joined with the index, after `cred check` ran in-process (the agent holds no secret). */
export async function buildCredentialCheckInput(d: CredDeps, cfg: Config, events: StandingEvent[]) {
  const results = await checkAll(d);
  const index = await d.store.readIndex();
  const stored = (name: string) => index[name] !== undefined;
  const plain = [
    { credential: "github-app-key", path: cfg.app.private_key_path },
    { credential: "telegram-bot", path: cfg.telegram?.credentials_path ?? "" },
  ].filter((f) => f.path && existsSync(f.path) && stored(f.credential));
  return {
    credentials: Object.values(d.catalogue).map((e) => ({
      name: e.name,
      provider: e.provider,
      purpose: e.purpose,
      access: e.access,
      used_by: e.used_by,
      setup: e.setup,
      state: stored(e.name) ? "set" : "missing",
      expires_at: index[e.name]?.expires_at ?? null,
      days_left: daysLeft(index[e.name]?.expires_at ?? null, d.now()),
      last_check: index[e.name]?.last_check ?? null,
      renew: typeof e.renew === "string" ? e.renew : "command",
    })),
    check_results: results,
    warn_days: cfg.credentials.warn_days,
    plain_files: plain,
    events,
    parties: await readParties(d.paths),
  };
}
