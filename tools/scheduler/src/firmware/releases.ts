import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { record } from "../events/store.ts";
import type { GitHubClient } from "../github/client.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { applyHilToBoard, type BoardCtx } from "./board.ts";
import { markHilRead } from "./gate.ts";
import { parseHilOutput, recordHilResult, type HilResult } from "./hil.ts";

/** Spec 070 AC-8: one recorded firmware build. */
export interface FirmwareRelease {
  tag: string;
  sha: string;
  published_at: string;
  channel: "beta" | "stable";
  hil: { conclusion: string; check_run_id: number; at: string } | null;
  soak: { started_at: string; results: number; last_at: string | null; resets: number; clean: boolean } | null;
  promoted_at: string | null;
  promoted_by: "scheduler" | "maintainer" | "superseded" | null;
  demoted_at: string | null;
  criteria: Record<string, boolean> | null;
}

/** AC-8: the repository's releases are listed at most this often. */
export const LIST_EVERY_S = 600;

export async function readReleases(p: StatePaths): Promise<FirmwareRelease[]> {
  try {
    return JSON.parse(await readFile(p.firmwareReleases, "utf8")) as FirmwareRelease[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function writeReleases(p: StatePaths, rs: FirmwareRelease[]): Promise<void> {
  for (const r of rs) {
    const v = validate("firmware-release", r);
    if (!v.ok) throw new Error(`invalid firmware release ${r.tag}: ${v.errors.join("; ")}`);
  }
  await mkdir(dirname(p.firmwareReleases), { recursive: true });
  const tmp = p.firmwareReleases + ".tmp";
  await writeFile(tmp, JSON.stringify(rs, null, 2));
  await rename(tmp, p.firmwareReleases);
}

export interface ReleaseDeps {
  prefix: string;
  hilCheck: string;
  paths: StatePaths;
  gh: Pick<GitHubClient, "listReleases" | "resolveTag" | "checkRunsNamed">;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  board: BoardCtx;
  /** Whether `sha` is an ancestor of origin/main in the scheduler's checkout. */
  onMain: (sha: string) => boolean;
  mainHead: () => string;
}

async function listedRecently(deps: ReleaseDeps): Promise<boolean> {
  try {
    const at = JSON.parse(await readFile(deps.paths.firmwareListedAt, "utf8")) as { at: string };
    return deps.now().getTime() - Date.parse(at.at) < LIST_EVERY_S * 1000;
  } catch {
    return false;
  }
}

/** AC-8: new tagged releases are recorded; the stable-when-first-seen ones are recorded and never edited. */
async function recordNew(deps: ReleaseDeps, rs: FirmwareRelease[]): Promise<FirmwareRelease[]> {
  const out = [...rs];
  for (const rel of await deps.gh.listReleases()) {
    if (!rel.tag.startsWith(deps.prefix) || out.some((r) => r.tag === rel.tag)) continue;
    const sha = await deps.gh.resolveTag(rel.tag);
    const onMain = deps.onMain(sha);
    out.push({
      tag: rel.tag, sha, published_at: rel.published_at, channel: rel.prerelease ? "beta" : "stable", hil: null, soak: null,
      promoted_at: null, promoted_by: null, demoted_at: null, criteria: null,
    });
    await record(deps.paths, "firmware.published", deps.now(), { tag: rel.tag, sha, channel: rel.prerelease ? "beta" : "stable", on_main: onMain });
    if (!onMain) {
      deps.log({ kind: "firmware-release-off-main", tag: rel.tag });
      out[out.length - 1]!.criteria = { off_main: true };
    }
  }
  return out;
}

const isOffMain = (r: FirmwareRelease): boolean => r.criteria?.off_main === true;

/** AC-9: a result moves the release whose build is on the board; the first completed `main` result of the release's own sha starts its soak. */
export function applyResultToReleases(rs: FirmwareRelease[], r: HilResult, run: { id: number; conclusion: string | null; completed_at: string | null }): void {
  const at = run.completed_at ?? "";
  for (const rel of rs) {
    if (rel.channel !== "beta" || isOffMain(rel)) continue;
    if (rel.hil === null && r.kind === "main" && r.sha === rel.sha) {
      rel.hil = { conclusion: run.conclusion ?? "unknown", check_run_id: run.id, at };
      if (run.conclusion === "success") rel.soak = { started_at: at, results: 0, last_at: at, resets: r.board.resets, clean: true };
      continue;
    }
    if (rel.soak && r.board.firmware_sha === rel.sha && run.id !== rel.hil?.check_run_id) {
      rel.soak = {
        ...rel.soak, results: rel.soak.results + 1, last_at: at > (rel.soak.last_at ?? "") ? at : rel.soak.last_at, resets: r.board.resets,
        clean: rel.soak.clean && r.outcome === "pass",
      };
    }
  }
}

/**
 * AC-8, AC-9: at most every 600 s, list releases and read the unread HIL check runs of main's head and of each beta
 * release's commit, applying each to the board first. Returns whether anything was done.
 */
export async function releaseStep(deps: ReleaseDeps): Promise<boolean> {
  if (await listedRecently(deps)) return false;
  let rs = await recordNew(deps, await readReleases(deps.paths));
  const shas = [...new Set([deps.mainHead(), ...rs.filter((r) => r.channel === "beta" && !isOffMain(r)).map((r) => r.sha)])];
  const fresh: { result: HilResult; run: { id: number; conclusion: string | null; completed_at: string | null } }[] = [];
  for (const sha of shas) {
    const runs = (await deps.gh.checkRunsNamed(sha, deps.hilCheck)).filter((r) => r.status === "completed").sort((a, b) => a.id - b.id);
    for (const run of runs) {
      if (!(await markHilRead(deps.paths, run.id))) continue;
      const read = parseHilOutput(run.output_text);
      if (!read.ok) {
        deps.log({ kind: "hil-result-invalid", check_run_id: run.id, error: read.error });
        continue;
      }
      await applyHilToBoard(deps.board, read.result, run.id);
      await recordHilResult(deps.paths, deps.now(), read.result, run.id);
      fresh.push({ result: read.result, run });
    }
  }
  fresh.sort((a, b) => (a.run.completed_at ?? "").localeCompare(b.run.completed_at ?? ""));
  for (const f of fresh) applyResultToReleases(rs, f.result, f.run);
  await writeReleases(deps.paths, rs);
  await mkdir(dirname(deps.paths.firmwareListedAt), { recursive: true });
  await writeFile(deps.paths.firmwareListedAt, JSON.stringify({ at: deps.now().toISOString() }));
  return true;
}
