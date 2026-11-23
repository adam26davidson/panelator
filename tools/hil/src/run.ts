// The sequence of a HIL run: the flashing run of spec 106 AC-12, the soak run of AC-15, the build-failed run of
// AC-11, all under the board lock of AC-9. Hardware, clock, lock and files are injected.
import { LiveBoard, Log } from "./board.ts";
import type { BoardConfig } from "./config.ts";
import { readLastGood, storeLastGood } from "./last-good.ts";
import { parseBanner, parseStatus, STATUS_PATTERN, type Banner, type Status } from "./lines.ts";
import { acquireLock, LockTimeout, type Clock } from "./lock.ts";
import { findPort, type PortDeps } from "./port.ts";
import { restoreLastGood, type Hardware } from "./restore.ts";
import { cutLog, emptyBoard, type BoardFields, type HilResult, type Kind, type Outcome, type TestResult } from "./result.ts";
import { suite, type HilTest } from "./suite/index.ts";

export interface RunInput {
  kind: Kind;
  /** The commit under test (the check is on it). */
  sha: string;
  runId: number;
  /** The unpacked build artifact; null for a soak run and when the build failed. */
  buildDir: string | null;
  /** Set when the build job failed or was cancelled: nothing is flashed. */
  buildFailed?: { runUrl: string };
}

export interface RunDeps extends Hardware {
  cache: string;
  ports: Omit<PortDeps, "prefixes">;
  isAlive?: (pid: number) => boolean;
  tests?: HilTest[];
  /** Called with the finished result while the lock is still held. */
  writeResult: (result: HilResult) => void;
}

export function deriveKind(event: string, ref: string, soakInput: boolean): Kind {
  if (event === "schedule") return "soak";
  if (event === "workflow_dispatch") return soakInput ? "soak" : ref === "refs/heads/main" ? "main" : "pr";
  return event === "push" ? "main" : "pr";
}

function boardFrom(status: Status | null, firmwareSha: string | null, state: BoardFields["status"] = "ok"): BoardFields {
  return {
    status: state,
    firmware_sha: status?.sha ?? firmwareSha,
    uptime_s: status?.uptime_s ?? null,
    resets: status?.resets ?? null,
    free_heap: status?.free_heap ?? null,
    free_psram: status?.free_psram ?? null,
  };
}

function lastStatus(lines: readonly string[]): Status | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseStatus(lines[i]!);
    if (s) return s;
  }
  return null;
}

function finish(input: RunInput, log: Log, outcome: Outcome, board: BoardFields, tests: TestResult[], reason?: string): HilResult {
  const result: HilResult = { outcome, kind: input.kind, sha: input.sha, run_id: input.runId, board, tests, log: cutLog(log.text()) };
  if (reason !== undefined) result.reason = reason;
  return result;
}

export async function runHil(input: RunInput, deps: RunDeps): Promise<HilResult> {
  const log = new Log();
  const partial: { board: BoardFields } = { board: emptyBoard("ok") };
  let release: (() => void) | undefined;
  let result: HilResult;
  try {
    try {
      release = await acquireLock(`${deps.cache}/board.lock`, {
        clock: deps.clock,
        timeoutMs: deps.config.timeouts_s.lock * 1000,
        isAlive: deps.isAlive,
      });
    } catch (e) {
      if (!(e instanceof LockTimeout)) throw e;
      result = finish(input, log, "fail", emptyBoard("ok"), [{ name: "board-lock", status: "fail", duration_ms: deps.config.timeouts_s.lock * 1000, message: e.message }], e.message);
      deps.writeResult(result);
      return result;
    }
    result = await body(input, deps, log, partial);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result = finish(input, log, "fail", partial.board, [{ name: "harness", status: "fail", duration_ms: 0, message }], message);
  }
  try {
    try {
      deps.writeResult(result);
    } catch (e) {
      // A result the schema refuses (or a file that cannot be written) becomes a harness failure.
      const message = e instanceof Error ? e.message : String(e);
      result = finish(input, log, "fail", partial.board, [{ name: "harness", status: "fail", duration_ms: 0, message }], message);
      deps.writeResult(result);
    }
  } finally {
    release?.();
  }
  return result;
}

async function body(input: RunInput, deps: RunDeps, log: Log, partial: { board: BoardFields }): Promise<HilResult> {
  const port = findPort({ ...deps.ports, prefixes: deps.config.port_prefixes });
  if (!port.found) {
    partial.board = emptyBoard("absent");
    return finish(input, log, "absent", partial.board, [], port.reason);
  }
  if (input.kind === "soak" || input.buildFailed) return soak(input, deps, log, partial, port.path);
  if (!input.buildDir) throw new Error("a flashing run needs the build artifact (--build-dir)");
  return flashing(input, deps, log, partial, port.path, input.buildDir);
}

async function timed<T>(clock: Clock, f: () => Promise<T>): Promise<[T, number]> {
  const start = clock.now();
  const value = await f();
  return [value, Math.max(0, Math.round(clock.now() - start))];
}

async function soak(input: RunInput, deps: RunDeps, log: Log, partial: { board: BoardFields }, port: string): Promise<HilResult> {
  const session = await deps.serial.open(port, { reset: false });
  let status: Status | null;
  let ms: number;
  try {
    const board = new LiveBoard(session, deps.clock, log, input.sha, deps.config);
    [status, ms] = await timed(deps.clock, async () => {
      const line = await board.waitForLine(STATUS_PATTERN, deps.config.timeouts_s.soak * 1000);
      return line === null ? null : parseStatus(line);
    });
  } finally {
    await session.close();
  }
  partial.board = boardFrom(status, null);
  if (input.buildFailed) {
    const message = `the build job did not succeed: ${input.buildFailed.runUrl}`;
    return finish(input, log, "fail", partial.board, [{ name: "build", status: "fail", duration_ms: 0, message }], message);
  }
  const test: TestResult = status
    ? { name: "status-line", status: "pass", duration_ms: ms }
    : { name: "status-line", status: "fail", duration_ms: ms, message: `no status line within ${deps.config.timeouts_s.soak} s` };
  return finish(input, log, status ? "pass" : "fail", partial.board, [test]);
}

async function downloadMode(deps: RunDeps, port: string, log: Log, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await deps.flasher.chipQuery(port);
    log.add(r.output);
    if (r.ok) return true;
  }
  return false;
}

async function flashing(
  input: RunInput,
  deps: RunDeps,
  log: Log,
  partial: { board: BoardFields },
  port: string,
  buildDir: string,
): Promise<HilResult> {
  const bricked = (reason: string, tests: TestResult[] = []): HilResult => {
    partial.board = emptyBoard("bricked");
    return finish(input, log, "bricked", partial.board, tests, reason);
  };
  if (!(await downloadMode(deps, port, log, 2))) return bricked("download mode could not be entered");

  const lastGood = readLastGood(deps.cache);
  const tests: TestResult[] = [];
  const flashed = await deps.flasher.flash(port, buildDir);
  log.add(flashed.output);
  let noBoot: string | null = flashed.ok ? null : "flashing the image under test failed";
  let banner: Banner | null = null;
  if (flashed.ok) {
    const session = await deps.serial.open(port, { reset: true });
    try {
      const board = new LiveBoard(session, deps.clock, log, input.sha, deps.config);
      for (const test of deps.tests ?? suite) {
        const [outcome, ms] = await timed(deps.clock, async () => {
          try {
            return await test.run(board);
          } catch (e) {
            return { status: "fail" as const, message: `threw: ${e instanceof Error ? e.message : String(e)}` };
          }
        });
        const t: TestResult = { name: test.name, status: outcome.status, duration_ms: ms };
        if ("message" in outcome && outcome.message !== undefined) t.message = outcome.message;
        tests.push(t);
        if (outcome.status === "fail" && outcome.noBanner) noBoot = outcome.message;
      }
      for (const l of board.lines()) banner = banner ?? parseBanner(l);
      partial.board = boardFrom(lastStatus(board.lines()), banner?.sha ?? null);
    } finally {
      await session.close();
    }
  } else {
    tests.push({ name: "boot-banner", status: "fail", duration_ms: 0, message: "flashing the image under test failed" });
  }

  if (noBoot !== null) return didNotBoot(input, deps, log, partial, port, tests, lastGood, noBoot);

  const passed = tests.every((t) => t.status !== "fail");
  const outcome: Outcome = passed ? "pass" : "fail";
  if (input.kind === "main" && passed) {
    storeLastGood(deps.cache, buildDir, input.sha);
  } else if (lastGood) {
    const back = await restoreLastGood(deps, port, lastGood, log, true);
    if (!back.ok) return bricked(`the last-good image ${lastGood.commit} was not running after the flash back: ${back.message}`, tests);
    partial.board = boardFrom(back.status, lastGood.commit);
  }
  return finish(input, log, outcome, partial.board, tests);
}

async function didNotBoot(
  input: RunInput,
  deps: RunDeps,
  log: Log,
  partial: { board: BoardFields },
  port: string,
  tests: TestResult[],
  lastGood: ReturnType<typeof readLastGood>,
  why: string,
): Promise<HilResult> {
  const annotate = (extra: string): void => {
    const t = tests.find((x) => x.name === "boot-banner");
    if (t) t.message = `${why}; ${extra}`;
  };
  if (lastGood) {
    const back = await restoreLastGood(deps, port, lastGood, log, true);
    if (back.ok) {
      annotate(`the image under test did not boot; the last-good image ${lastGood.commit} was restored`);
      partial.board = boardFrom(back.status, lastGood.commit);
      return finish(input, log, "fail", partial.board, tests);
    }
    partial.board = emptyBoard("bricked");
    return finish(input, log, "bricked", partial.board, tests, `the image under test did not boot and the restore of ${lastGood.commit} failed: ${back.message}`);
  }
  if (await downloadMode(deps, port, log, 1)) {
    annotate("no last-good image exists yet, so none was restored; the board answers in download mode");
    partial.board = { ...emptyBoard("ok"), firmware_sha: input.sha };
    return finish(input, log, "fail", partial.board, tests);
  }
  partial.board = emptyBoard("bricked");
  return finish(input, log, "bricked", partial.board, tests, "the image under test did not boot, no last-good image exists and download mode does not answer");
}

