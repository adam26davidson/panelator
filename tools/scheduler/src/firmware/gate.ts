import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChainEvent } from "../chain/types.ts";
import type { Config } from "../config.ts";
import { recordChecks } from "../events/ci.ts";
import { matchesAny } from "../glob.ts";
import type { GitHubClient } from "../github/client.ts";
import type { StatePaths } from "../state/paths.ts";
import { applyHilToBoard, boardDown, readBoard, type BoardCtx } from "./board.ts";
import { hilVerdict, recordHilResult } from "./hil.ts";
import { isFirmwarePr } from "./paths.ts";

export interface GateDeps {
  cfg: Config;
  paths: StatePaths;
  gh: Pick<GitHubClient, "checkRunsNamed">;
  now: () => Date;
  board: BoardCtx;
}

/** What the HIL check adds to verify of one head: nothing, a block, or the state of the check beside the required checks. */
export type FirmwareGate =
  | { kind: "none" }
  | { kind: "event"; event: ChainEvent }
  | { kind: "hil"; state: "pending" | "passed" | "failed"; name: string; log?: string; failedId?: number };

/** AC-9: every HIL check run read once, by id, whichever reader sees it first (a chain's verify or the release step). */
export async function markHilRead(paths: StatePaths, id: number): Promise<boolean> {
  let ids: number[] = [];
  try {
    ids = JSON.parse(await readFile(paths.firmwareHilRead, "utf8")) as number[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (ids.includes(id)) return false;
  await writeFile(paths.firmwareHilRead, JSON.stringify([...ids, id]));
  return true;
}

/** Spec 070 AC-2, AC-3, AC-5: the board gate of verify for a firmware PR's head. */
export async function firmwareGate(
  deps: GateDeps,
  a: { worktree: string; head: string; pr: number; files: string[]; sensitive: boolean; mainSha: () => Promise<string> },
): Promise<FirmwareGate> {
  const fw = deps.cfg.firmware;
  if (!fw || !isFirmwarePr(a.files, fw.paths)) return { kind: "none" };
  const workflow = `.github/workflows/${fw.hil_workflow}`;
  if (!existsSync(join(a.worktree, workflow))) {
    return { kind: "event", event: { type: "hil_missing", sensitive: a.sensitive, mainSha: await a.mainSha(), path: workflow, files: a.files.filter((f) => matchesAny(f, fw.paths)) } };
  }
  const down = async (reason: string, runId: number | null, brick: boolean): Promise<FirmwareGate> =>
    ({ kind: "event", event: { type: "hil_board", sensitive: a.sensitive, mainSha: await a.mainSha(), reason, runId, brick } });
  const board = await readBoard(deps.paths);
  if (boardDown(board)) return down(`the test board is ${board.status}: ${board.reason ?? "no reason recorded"}`, null, false);

  const runs = await deps.gh.checkRunsNamed(a.head, fw.hil_check);
  const done = runs.filter((r) => r.status === "completed");
  if (done.length) {
    await recordChecks(deps.paths, deps.now(), { sha: a.head, pr: a.pr }, { status: "green", failed: [], runs: done.map((r) => ({ name: r.name, id: r.id, status: r.status, conclusion: r.conclusion })) });
  }
  const verdict = hilVerdict(runs);
  if (verdict.state === "pending") return { kind: "hil", state: "pending", name: fw.hil_check };
  const fresh = await markHilRead(deps.paths, verdict.run.id);
  if (verdict.state === "failed" && !verdict.result) return { kind: "hil", state: "failed", name: fw.hil_check, log: verdict.lines, failedId: verdict.run.id };
  const result = verdict.state === "failed" || verdict.state === "passed" || verdict.state === "board" ? verdict.result! : null;
  if (fresh && result) {
    await applyHilToBoard(deps.board, result, verdict.run.id, a.pr);
    await recordHilResult(deps.paths, deps.now(), result, verdict.run.id, a.pr);
  }
  if (verdict.state === "board") {
    if (fresh) return down(result!.reason ?? `HIL result ${result!.outcome}`, result!.run_id, result!.outcome === "bricked");
    // A result already read and answered: once the board is back, the chain waits for the re-run's result.
    const now = await readBoard(deps.paths);
    return boardDown(now) ? down(`the test board is ${now.status}: ${now.reason ?? ""}`, result!.run_id, false) : { kind: "hil", state: "pending", name: fw.hil_check };
  }
  if (verdict.state === "failed") return { kind: "hil", state: "failed", name: fw.hil_check, log: verdict.lines, failedId: verdict.run.id };
  return { kind: "hil", state: "passed", name: fw.hil_check };
}
