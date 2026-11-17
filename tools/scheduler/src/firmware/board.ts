import { readFile, rename, writeFile } from "node:fs/promises";
import { record } from "../events/store.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import type { HilResult } from "./hil.ts";

export type BoardStatus = "ok" | "absent" | "bricked" | "unknown";

/** Spec 070 AC-4: `board.json`. */
export interface BoardState {
  status: BoardStatus;
  since: string | null;
  reason: string | null;
  check_run_id: number | null;
  pr: number | null;
  confirmed_at: string | null;
  confirmed_by: "maintainer" | null;
}

export const UNKNOWN_BOARD: BoardState = { status: "unknown", since: null, reason: null, check_run_id: null, pr: null, confirmed_at: null, confirmed_by: null };

/** Section 8 of spec 070, until the firmware work replaces it with the project's own. */
export const RECOVERY_STEPS = [
  "Unplug and replug the board's USB cable.",
  "Hold BOOT while pressing RESET to enter download mode.",
  "Run the restore command the firmware work provides, which flashes the last-good image from the runner's cache.",
  "Wait for the boot banner on the serial console.",
  "Then run `panelator-scheduler board back`.",
];

export interface BoardCtx {
  paths: StatePaths;
  now: () => Date;
  repo: string;
  log: (rec: Record<string, unknown>) => void;
  telegram?: { sendReply(text: string, replyTo?: number): Promise<number> } | null;
}

export async function readBoard(p: StatePaths): Promise<BoardState> {
  try {
    return JSON.parse(await readFile(p.board, "utf8")) as BoardState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...UNKNOWN_BOARD };
    throw e;
  }
}

async function writeBoard(p: StatePaths, s: BoardState): Promise<void> {
  const v = validate("board-state", s);
  if (!v.ok) throw new Error(`invalid board state: ${v.errors.join("; ")}`);
  const tmp = p.board + ".tmp";
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, p.board);
}

/** Every status change records one `board.changed` event; a change to bricked or absent tells the maintainer once (AC-7). */
async function change(ctx: BoardCtx, from: BoardState, to: BoardState, reason: string): Promise<void> {
  await writeBoard(ctx.paths, to);
  await record(ctx.paths, "board.changed", ctx.now(), { from: from.status, to: to.status, reason, check_run_id: to.check_run_id });
  if (to.status === "bricked" || to.status === "absent") await announce(ctx, to);
}

/**
 * AC-4: a HIL result is applied to the board before anything else is done with it. `bricked` sets bricked; `absent` sets
 * absent unless bricked; a result that sees the board ok sets ok only from unknown or absent. Nothing here leaves `bricked`.
 */
export async function applyHilToBoard(ctx: BoardCtx, r: HilResult, checkRunId: number, pr: number | null = null): Promise<BoardState> {
  const cur = await readBoard(ctx.paths);
  const at = ctx.now().toISOString();
  const base = { since: at, reason: r.reason ?? `HIL result ${r.outcome}`, check_run_id: checkRunId, pr, confirmed_at: null, confirmed_by: null };
  if (r.outcome === "bricked") {
    if (cur.status === "bricked") return cur;
    await change(ctx, cur, { status: "bricked", ...base }, base.reason);
    return readBoard(ctx.paths);
  }
  if (r.outcome === "absent") {
    if (cur.status === "bricked" || cur.status === "absent") return cur;
    await change(ctx, cur, { status: "absent", ...base }, base.reason);
    return readBoard(ctx.paths);
  }
  if (r.board.status === "ok" && (cur.status === "unknown" || cur.status === "absent")) {
    await change(ctx, cur, { status: "ok", ...base, reason: "a HIL result saw the board" }, "a HIL result saw the board");
    return readBoard(ctx.paths);
  }
  return cur;
}

/** The maintainer's `board_bricked`: sets bricked by hand; AC-5 and AC-7 follow as for a result. */
export async function markBricked(ctx: BoardCtx, reason: string): Promise<BoardState> {
  const cur = await readBoard(ctx.paths);
  if (cur.status === "bricked") return cur;
  await change(ctx, cur, { status: "bricked", since: ctx.now().toISOString(), reason, check_run_id: null, pr: null, confirmed_at: null, confirmed_by: null }, reason);
  return readBoard(ctx.paths);
}

/** The only writer of `ok` over `bricked`: the `board_back` action kind (its check refuses any actor but the maintainer). */
export async function confirmBack(ctx: BoardCtx): Promise<{ changed: boolean; state: BoardState }> {
  const cur = await readBoard(ctx.paths);
  if (cur.status === "ok" || cur.status === "unknown") return { changed: false, state: cur };
  const at = ctx.now().toISOString();
  await change(ctx, cur, { status: "ok", since: at, reason: "the maintainer confirmed the board is back", check_run_id: cur.check_run_id, pr: cur.pr, confirmed_at: at, confirmed_by: "maintainer" }, "the maintainer confirmed the board is back");
  return { changed: true, state: await readBoard(ctx.paths) };
}

export const boardDown = (s: BoardState): boolean => s.status === "bricked" || s.status === "absent";

export function alertText(repo: string, s: BoardState): string {
  const lines = [`The test board is ${s.status}.`, `Reason: ${s.reason ?? "(none given)"}`];
  if (s.pr) lines.push(`PR: #${s.pr}`);
  if (s.check_run_id) lines.push(`Check run: https://github.com/${repo}/runs/${s.check_run_id}`);
  lines.push(s.status === "absent" ? "Connect the board's USB cable to the laptop." : "Recovery:", ...(s.status === "absent" ? [] : RECOVERY_STEPS.map((l, i) => `${i + 1}. ${l}`)));
  lines.push("When the board is back, run `panelator-scheduler board back` on the laptop. Firmware work waits until then; other work continues.");
  return lines.join("\n");
}

async function send(ctx: BoardCtx, s: BoardState, label: string): Promise<void> {
  const text = alertText(ctx.repo, s);
  let channel = "log";
  if (ctx.telegram) {
    try {
      await ctx.telegram.sendReply(text);
      channel = "telegram";
    } catch (e) {
      ctx.log({ kind: "board-alert-telegram-failed", error: (e as Error).message });
    }
  }
  ctx.log({ kind: "board-alert", status: s.status, text });
  await record(ctx.paths, "maintainer.contact", ctx.now(), { channel, kind: "notification", label, text });
}

async function announce(ctx: BoardCtx, s: BoardState): Promise<void> {
  await writeFile(ctx.paths.boardAlert, JSON.stringify({ status: s.status, at: ctx.now().toISOString(), reminded: false }));
  await send(ctx, s, `board-${s.status}`);
}

/** AC-7: still bricked or absent 24 hours after the message: one reminder, and no more. */
export async function remindBoard(ctx: BoardCtx): Promise<void> {
  const s = await readBoard(ctx.paths);
  if (!boardDown(s)) return;
  let alert: { status: string; at: string; reminded: boolean };
  try {
    alert = JSON.parse(await readFile(ctx.paths.boardAlert, "utf8"));
  } catch {
    return;
  }
  if (alert.reminded || alert.status !== s.status || ctx.now().getTime() - Date.parse(alert.at) < 24 * 3_600_000) return;
  await writeFile(ctx.paths.boardAlert, JSON.stringify({ ...alert, reminded: true }));
  await send(ctx, s, `board-${s.status}`);
}
