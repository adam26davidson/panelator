import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { finished } from "node:stream/promises";
import { JsonlSplitter } from "../adapters/jsonl.ts";
import type { Adapter, Judgement, RunOutcome, StageRun } from "../adapters/types.ts";
import { validate, type SchemaName } from "../schema/validate.ts";
import { renderPrompt, type StageInput } from "../stages/prompt.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";
import { newRunId, runDir, writeUsageRecord, type UsageRecord } from "../state/runs.ts";
import type { Harness, Profile, StageDefinition } from "../types.ts";
import { spawnBounded, type SpawnResult } from "./process.ts";
import { linkProfileSkills } from "./skills.ts";

export interface RunnerContext {
  paths: StatePaths;
  adapter: Adapter;
  systemdScope: boolean;
  systemdRunBin?: string;
  now?: () => Date;
  sessionId?: () => string;
  binDir: string;
}

export interface StageRequest {
  def: StageDefinition;
  input: StageInput;
  issue: number;
  attempt: number;
  worktree: string;
  profile: Profile | null;
  model?: string;
  harness?: Harness;
}

export interface StageOutcome {
  runId: string;
  outcome: RunOutcome;
  reason: string | null;
  result: unknown | null;
  resultErrors: string[];
  judgement: Judgement;
  usage: UsageRecord;
  findings: { queued: number; rejected: string[] };
  eventsPath: string;
  /** Lines of events.jsonl that did not parse (e.g. a partial tail from a killed process). */
  malformed: string[];
}

const rec = (e: unknown): Record<string, unknown> => (typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {});

export async function runStage(ctx: RunnerContext, req: StageRequest): Promise<StageOutcome> {
  // The adapter decides what runs, so it is the single source of the harness (skills link, AC-24 record).
  const harness: Harness = ctx.adapter.harness;
  if (req.harness !== undefined && req.harness !== harness && harness !== "fake") {
    throw new Error(`harness mismatch: request asks for ${req.harness} but the adapter is ${harness}`);
  }
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const runId = newRunId(req.issue, req.def.name, req.attempt, startedAt);
  const dir = runDir(ctx.paths, runId);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "result.json");
  const eventsPath = join(dir, "events.jsonl");
  const model = req.model ?? req.def.model;

  const profileInstructions = req.profile
    ? [req.profile.instructions, req.profile.reviewCriteria].filter(Boolean).join("\n\n")
    : req.input.profile_instructions ?? "";
  const input: StageInput = { ...req.input, result_path: resultPath, profile_instructions: profileInstructions };
  const iv = validate("stage-input", input);
  if (!iv.ok) throw new Error(`stage input invalid: ${iv.errors.join("; ")}`);
  const prompt = renderPrompt(req.def.prompt, input);
  await writeFile(join(dir, "prompt.md"), prompt);
  await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));

  if (req.profile && harness !== "fake") await linkProfileSkills(req.worktree, harness, req.profile);

  const stageRun: StageRun = {
    runId, stage: req.def.name, attempt: req.attempt, issue: req.issue, prompt, model, bounds: req.def.bounds,
    worktree: req.worktree, sessionId: (ctx.sessionId ?? randomUUID)(), resultPath, profile: req.profile, effort: req.def.effort,
  };
  const cmd = ctx.adapter.buildCommand(stageRun);
  await writeFile(join(dir, "command.txt"), JSON.stringify({ argv: cmd.argv, env: Object.keys(cmd.env), cwd: req.worktree }, null, 2));

  const splitter = new JsonlSplitter();
  const events: unknown[] = [];
  let turnEnds = 0;
  let endsWithLf = true; // nothing written yet
  // Write errors are captured, never thrown from the handler (an unhandled stream error would crash the service).
  const ioErrors: Error[] = [];
  const eventsOut = createWriteStream(eventsPath).on("error", (e) => ioErrors.push(e));
  const stderrOut = createWriteStream(join(dir, "stderr.log")).on("error", (e) => ioErrors.push(e));
  const spawnStart = Date.now();
  let spawned: SpawnResult | null = null;
  let spawnError: string | null = null;
  let malformed: string[] = [];
  try {
    try {
      spawned = await spawnBounded({
        argv: cmd.argv,
        env: { ...cmd.env, PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`, PANELATOR_STATE_DIR: ctx.paths.root },
        cwd: req.worktree,
        timeoutMs: req.def.bounds.timeout_min * 60_000,
        scope: { enabled: ctx.systemdScope, unitName: `panelator-stage-${runId}`, systemdRunBin: ctx.systemdRunBin },
        onStdoutChunk: (c) => {
          eventsOut.write(c);
          if (c.length) endsWithLf = c[c.length - 1] === 0x0a;
          for (const e of splitter.push(c)) {
            events.push(e);
            if (ctx.adapter.isTurnEnd?.(e) === true) turnEnds++;
          }
        },
        onStderrChunk: (c) => stderrOut.write(c),
        killOnEvent: () => turnEnds > req.def.bounds.max_turns,
      });
    } catch (e) {
      spawnError = (e as Error).message;
    }
    const tail = splitter.end();
    events.push(...tail.records);
    malformed = tail.malformed;
    if (spawned?.killedByEvent) {
      const b = { type: "scheduler_bounds", reason: "max_turns" };
      events.push(b);
      // A killed process often leaves a partial last line; keep the marker on its own line.
      eventsOut.write((endsWithLf ? "" : "\n") + JSON.stringify(b) + "\n");
    }
  } finally {
    await Promise.all([closeStream(eventsOut), closeStream(stderrOut)]);
  }

  let judgement: Judgement;
  if (spawned === null) {
    judgement = { outcome: "failed", reason: `spawn: ${spawnError}`, apiErrorStatus: null, finalText: null };
  } else {
    judgement = ctx.adapter.judge(events, spawned.exitCode, spawned.timedOut);
    if (spawned.killedByEvent && !spawned.timedOut) judgement = { outcome: "bounds", reason: "max_turns", apiErrorStatus: null, finalText: null };
  }

  // A process that never started, timed out, or was stopped for a bound cannot be trusted to have
  // finished its result, so the file is not read (review focus 2).
  let result: unknown | null = null;
  let parsed: unknown = null;
  let resultErrors: string[] = [];
  if (spawned !== null && judgement.outcome !== "timeout" && judgement.outcome !== "bounds") {
    const raw = await readFile(resultPath, "utf8").catch(() => null);
    if (raw === null) resultErrors = ["result file missing"];
    else {
      try {
        parsed = JSON.parse(raw);
        const v = validate(req.def.output as SchemaName, parsed);
        if (v.ok) result = parsed;
        else resultErrors = v.errors;
      } catch (e) {
        resultErrors = [`result file is not JSON: ${(e as Error).message}`];
      }
    }
    if (judgement.outcome === "ok" && resultErrors.length) judgement = { ...judgement, outcome: "failed", reason: "result: invalid" };
  }

  // Findings are a side channel: queued from any result that parsed, valid or not (AC-28).
  const findingsIn = Array.isArray(rec(parsed).findings) ? (rec(parsed).findings as unknown[]) : [];
  const findings = await appendFindings(ctx.paths, { issue: req.issue, stage: req.def.name, run_id: runId, timestamp: now().toISOString() }, findingsIn);

  const endedAt = now();
  const u = ctx.adapter.usage(events);
  const wallMs = spawned?.wallMs ?? Date.now() - spawnStart;
  const usage: UsageRecord = {
    run_id: runId, issue: req.issue, stage: req.def.name, attempt: req.attempt, outcome: judgement.outcome, harness, model,
    ...u, wall_seconds: Math.max(0.001, wallMs / 1000), started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(),
    events_path: relative(ctx.paths.root, eventsPath),
  };
  await writeUsageRecord(ctx.paths, usage);

  return { runId, outcome: judgement.outcome, reason: judgement.reason, result, resultErrors, judgement, usage, findings, eventsPath, malformed };
}

/** Ends a write stream and waits for it to settle, whether it finishes or errors. */
async function closeStream(s: WriteStream): Promise<void> {
  if (!s.writableEnded) s.end();
  await finished(s).catch(() => {});
}
