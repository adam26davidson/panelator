import { openIndex } from "../events/index.ts";
import { record } from "../events/store.ts";
import type { GitHubClient } from "../github/client.ts";
import type { StatePaths } from "../state/paths.ts";
import { readBoard } from "./board.ts";
import { readReleases, writeReleases, type FirmwareRelease } from "./releases.ts";

export const CRITERIA = ["hil_passed", "soaked", "soak_clean", "board_ok", "latest", "not_demoted"] as const;
export type Criteria = Record<(typeof CRITERIA)[number], boolean>;

export interface PromoteDeps {
  paths: StatePaths;
  gh: Pick<GitHubClient, "listReleases" | "setReleasePrerelease">;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  soakMs: number;
  enabled: boolean;
  /** Whether `a` is an ancestor of `b` on main. */
  isAncestor: (a: string, b: string) => boolean;
  /** The maintainer is told, information only; failures are the caller's to log. */
  tell: (text: string) => Promise<void>;
}

/** AC-10: the six criteria of one beta release, as evaluated now. */
export async function evaluate(deps: PromoteDeps, rel: FirmwareRelease, all: FirmwareRelease[]): Promise<Criteria> {
  const soak = rel.soak;
  const board = await readBoard(deps.paths);
  let leftOk = false;
  if (soak) {
    const db = openIndex(deps.paths, { readOnly: true });
    try {
      leftOk = Boolean(db.prepare("SELECT 1 FROM events WHERE kind = 'board.changed' AND json_extract(payload, '$.from') = 'ok' AND at > ? LIMIT 1").get(soak.started_at));
    } finally {
      db.close();
    }
  }
  return {
    hil_passed: rel.hil?.conclusion === "success",
    soaked: soak !== null && soak.last_at !== null && Date.parse(soak.last_at) - Date.parse(soak.started_at) >= deps.soakMs && soak.results >= 2,
    soak_clean: soak !== null && soak.clean && soak.resets === 0,
    board_ok: soak !== null && board.status === "ok" && !leftOk,
    latest: !all.some((o) => o.tag !== rel.tag && o.channel === "beta" && o.hil?.conclusion === "success" && o.promoted_by === null && deps.isAncestor(rel.sha, o.sha) && o.sha !== rel.sha),
    not_demoted: rel.demoted_at === null,
  };
}

const waiting = (c: Criteria): string[] => CRITERIA.filter((k) => !c[k]);

/** The tick's `firmware` field (AC-10). */
export interface FirmwareLine { stable: string | null; next: { tag: string; waiting_on: string[] } | null }

/** Beta releases still in play: not superseded, not off main. */
const candidates = (rs: FirmwareRelease[]): FirmwareRelease[] => rs.filter((r) => r.channel === "beta" && r.promoted_by === null && r.criteria?.off_main !== true);

async function setFlag(deps: PromoteDeps, tag: string, prerelease: boolean): Promise<void> {
  const rel = (await deps.gh.listReleases()).find((r) => r.tag === tag);
  if (!rel) throw new Error(`no release ${tag}`);
  await deps.gh.setReleasePrerelease(rel.id, prerelease);
}

/** Edits the release, then writes the record (AC-10: the record only after the edit succeeds). */
export async function promote(deps: PromoteDeps, tag: string, by: "scheduler" | "maintainer"): Promise<FirmwareRelease> {
  const rs = await readReleases(deps.paths);
  const rel = rs.find((r) => r.tag === tag);
  if (!rel) throw new Error(`no recorded firmware release ${tag}`);
  if (rel.channel !== "beta") throw new Error(`${tag} is not a beta release`);
  const criteria = await evaluate(deps, rel, rs);
  await setFlag(deps, tag, false);
  const at = deps.now().toISOString();
  Object.assign(rel, { channel: "stable", promoted_at: at, promoted_by: by, criteria });
  for (const o of rs) if (o !== rel && o.channel === "beta" && o.promoted_by === null && Date.parse(o.published_at) < Date.parse(rel.published_at)) o.promoted_by = "superseded";
  await writeReleases(deps.paths, rs);
  await record(deps.paths, "firmware.promoted", deps.now(), { tag, sha: rel.sha, by, criteria });
  await deps.tell(`Firmware ${tag} was promoted to stable${by === "maintainer" ? " by you" : ": its tests passed on the board and it ran clean for the soak period"}.`).catch((e) => deps.log({ kind: "firmware-telegram-failed", error: (e as Error).message }));
  return rel;
}

/** AC-12: the prerelease flag back; a demoted release is never promoted again by the scheduler. */
export async function demote(deps: PromoteDeps, tag: string, reason: string): Promise<FirmwareRelease> {
  const rs = await readReleases(deps.paths);
  const rel = rs.find((r) => r.tag === tag);
  if (!rel) throw new Error(`no recorded firmware release ${tag}`);
  await setFlag(deps, tag, true);
  Object.assign(rel, { channel: "beta", demoted_at: deps.now().toISOString() });
  await writeReleases(deps.paths, rs);
  await record(deps.paths, "firmware.demoted", deps.now(), { tag, sha: rel.sha, reason });
  return rel;
}

/** AC-10: evaluate every candidate, write `criteria`, promote at most one, and return the tick-line field. */
export async function promotionStep(deps: PromoteDeps): Promise<FirmwareLine> {
  const rs = await readReleases(deps.paths);
  const evaluated = new Map<string, Criteria>();
  for (const rel of candidates(rs)) {
    const c = await evaluate(deps, rel, rs);
    evaluated.set(rel.tag, c);
    rel.criteria = c;
  }
  await writeReleases(deps.paths, rs);
  const ready = candidates(rs).filter((r) => waiting(evaluated.get(r.tag)!).length === 0).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (ready && deps.enabled) {
    try {
      await promote(deps, ready.tag, "scheduler");
    } catch (e) {
      deps.log({ kind: "firmware-promote-failed", tag: ready.tag, error: (e as Error).message });
    }
  }
  return line(await readReleases(deps.paths), evaluated);
}

function line(rs: FirmwareRelease[], evaluated: Map<string, Criteria>): FirmwareLine {
  const stable = rs.filter((r) => r.channel === "stable").sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]?.tag ?? null;
  const next = candidates(rs).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  return { stable, next: next ? { tag: next.tag, waiting_on: evaluated.has(next.tag) ? waiting(evaluated.get(next.tag)!) : [] } : null };
}
