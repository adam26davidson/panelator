# 103. A torn JSONL line is skipped and reported, a NUL-prefixed record is recovered, and the service log is read from its tail

Status: written 2026-11-21 from the delivery-system design for issue #254;
specs derived from that design need no maintainer approval (design section
11). Amends no earlier criterion: the inputs of
[064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-5, [008-agent-registry](../008-agent-registry/spec.md) AC-23 and
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md)
keep their content and gain a reading that survives a torn line.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (the standing agents, their inputs built by the scheduler; infra
health is "the ops-watcher slot": the agent that notices other agents
failing) and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design);
[ADR 0002](../../docs/decisions/0002-event-store-jsonl-with-sqlite-query-index.md)
("appending a line is its durability primitive, and a crash between an effect
and its record is already reasoned about in those terms": the state directory
is JSON and JSONL files, and a crash leaves a torn line);
[026-event-store](../026-event-store/spec.md) AC-3 (the events index skips a
line it cannot parse, counts it and logs `events-index-skipped-lines`: the
behaviour this spec gives the other readers);
[064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-5 (the infra health input: the last 24 hours of the service log's tick
summaries, restarts and `disk-sweep*` lines, the action log of the last 7
days); [008-agent-registry](../008-agent-registry/spec.md) AC-23 (the action
audit reads the action log and the parameter history);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md)
(a queue record's ref is its line number; the cursor follows the triage log);
[093-scheduler-failure-findings-name-their-cause](../093-scheduler-failure-findings-name-their-cause/spec.md)
(the `standing agent <name> failed twice` finding, which was the only record
of the failures this spec repairs).

## 1. Goal

One line that does not parse, anywhere in a JSONL state file, no longer
disables the standing agent that reads the file. The readers of the service
log, the action log, the parameter history, the findings queue and the triage
log skip such a line, recover a record that a block of NUL bytes precedes,
report what they skipped, and go on. The service log, which is the largest of
these files and grows without bound, is filtered to its last 24 hours by
reading from its end instead of parsing its whole history every six hours.

### What happened (spec agent's reading of the issue and the code, 2026-11-21)

The scheduler stopped uncleanly on 2026-11-13 between two ticks. On restart
`log/service.jsonl` and `events/2026-11.jsonl` each held one line made of NUL
bytes followed by the next valid record: with delayed allocation the file had
grown but the appended bytes never reached the disk, and the next append
landed after the hole. From then on every infra-health run (nine between
2026-11-15 and 2026-11-17) failed before the model ran:

```
standing-error agent=infra-health error="Unexpected token '\u0000', "\u0000\u0000…" is not valid JSON"
```

`readJsonLines` in `tools/scheduler/src/filer/input.ts` reads a whole file,
splits it on newlines and runs `JSON.parse` on every non-empty line; the
first bad line throws, and the throw ends the input build. The infra health
input (`src/standing/infra-health-input.ts`) applies its 24-hour filter after
the parse, so a torn line four days old still broke it. The same function
reads the action log and the parameter history for the action audit
(`src/standing/audit-input.ts`), the findings queue and the triage log for
the filer (`src/filer/input.ts`, `src/filer/apply.ts`) and the triage log and
queue for the reflections (`src/reflection/input.ts`); `ActionLog.list()` in
`src/actions/log.ts` parses the action log the same strict way for
`markStalePending` at service start, for the undo command and for the
`rerun_workflow` once-a-day check. A torn line in any of these files disables
the agent or the command that reads it, with no end date, until someone edits
the file by hand. The events index (`src/events/index.ts`, spec 026 AC-3)
already skips a line it cannot parse, counts it and logs
`events-index-skipped-lines`; this spec gives the other readers the same
behaviour, and a recovery the index does not attempt.

### The fix

*(agent's call)* One tolerant reader for every JSONL state file the scheduler
reads back, in one module, with the events index's behaviour as its model:

- A line is parsed after its leading NUL bytes are stripped. A line that is
  all NULs, or that still does not parse as a JSON object, is skipped; a
  line that parses once the NULs are gone is a recovered record. Nothing is
  written back: the files stay as the crash left them, the repair is in the
  reading. (A write-back repair would shift the findings queue's line
  numbers, which are its refs, and the events files' byte offsets, which the
  index stores; the issue's manual repair avoided both for the same reason.)
- Each read that skipped or recovered a line writes one service-log record,
  `jsonl-skipped-lines`, naming the file, the counts and the first positions,
  as the events index does. Whether skipped lines recur, and whether that is
  worth a finding, is judged by infra health, the agent whose job it is: its
  input carries the skips of its own build and the day's `jsonl-skipped-lines`
  records, and its prompt says when they are a finding.
- The findings queue is read with positions kept: a skipped line is a hole
  at its index, never a shift of the refs after it (spec 014: a ref is a line
  number). The filer's input already treats a queue entry as possibly absent.
- The service log is read from its end, in chunks, back to the first chunk
  that holds nothing newer than the cutoff. The log has one writer, which
  stamps `at` at write time, so the records are in time order except across
  a clock change, and the chunk rule tolerates a short disorder.

Nothing here is a product decision or a large technical decision: the
behaviour exists in the code base for the events index, the formats are
unchanged, and the readers are internal to the scheduler.

## 2. Out of scope

- The events files and their index (spec 026 AC-3): unchanged. The events
  index skips a torn events line already; `events/2026-11.jsonl` line 13167
  stays as it is, and the one `slots.sample` event it covered stays missing
  from the index, as the issue records.
- Other readers of JSONL files that the issue does not name: the monthly
  events file read by `src/aws/cost.ts` (`monthEvents`), the contacts log
  (`src/contacts/log.ts`), the merges file (`src/state/merges.ts`) and the
  one-time backfill (`src/events/backfill.ts`). They have the same weakness;
  a finding in this spec's result names them. The questions log
  (`src/state/questions.ts`) already skips a line it cannot parse.
- Repairing any file on disk, by the scheduler or by a command. The service
  log's line 38550 was repaired by hand on 2026-11-17; nothing here undoes
  or repeats that.
- Rotating, truncating or compacting the service log. Its growth is bounded
  only by the disk sweep as today; this spec changes how it is read, not how
  it is written.
- The cursor rule of spec 014 AC-2 and AC-4: `settledCursor` still advances
  past consecutive settled refs and stops before a hole (a hole has no
  triage row, so it is never settled). The scan after the cursor skips the
  hole as it does today, at a cost linear in the queue's length, which is
  what it costs today for any unsettled record.
- The writer side: `ServiceLog.write`, `appendFindings`, the triage append
  and the action log's appends are unchanged. Whether an append should
  `fsync` is not decided here; the issue asks for a tolerant read.
- `docs/charter.md`; `docs/delivery-system-design.md` beyond its
  `## Children` section.

## 3. Acceptance criteria

"Given" states use temporary state directories written by the tests, as
`tools/scheduler/test/infra-health-input.test.ts` and `filer.test.ts` do
today. *A NUL-only line* is a line of one or more `\u0000` bytes and nothing
else. *A NUL-prefixed record* is a line of one or more `\u0000` bytes followed
by a valid JSON object. *A torn line* is any line that is not a valid JSON
object after its leading NULs are stripped (a NUL-only line, a truncated
record, a record followed by garbage, a bare number). *Skipped* means left
out of the records returned; *recovered* means returned after the NULs were
stripped. *The report* is the service-log record of AC-2.

- AC-1. **One tolerant reader.** Given a JSONL file holding, in order, a
  valid record, a NUL-only line, a NUL-prefixed record, a truncated record
  (`{"at":"2026-11-13T2`), an empty line, a line `42`, and a valid record,
  when it is read through `readJsonLines(path, opts)` of the new module
  `tools/scheduler/src/state/jsonl.ts`, then the result holds the first
  record, the recovered record and the last record, in file order; the
  NUL-only line, the truncated record and `42` are skipped; the empty line
  is neither returned nor counted (as today's `filter(Boolean)`); and the
  reader throws only on a read error other than `ENOENT`, which returns the
  empty list as today. Given `opts.positional` is true, then the result has
  one entry per line of the file (the last newline's empty remainder
  excepted): a valid or recovered record at its index and `undefined` at the
  index of a skipped or empty line, so the line number of every later record
  is unchanged. `readJsonLines` keeps its name and its `T[]` return type for
  the callers and tests that import it today; `src/filer/input.ts` re-exports
  it from the new module, or the imports move, at the implementer's choice.
- AC-2. **Skips are reported once per read.** Given a read through AC-1's
  reader with `opts.log` set, when it skipped or recovered at least one line,
  then it writes exactly one record through `opts.log`: `{ kind:
  "jsonl-skipped-lines", file, skipped, recovered, offsets, lines? }`, where
  `file` is the path, `skipped` and `recovered` are the counts, `offsets` is
  the byte offset of the start of each skipped or recovered line, at most the
  first 10, and `lines` is the 1-based line number of each of them, at most
  the first 10, present when the whole file was read (AC-6's tail read has
  offsets only). Given a read that skipped and recovered nothing, then
  nothing is written. Given no `opts.log`, then nothing is written and the
  read is otherwise the same (the tests that read files through
  `readJsonLines` need no log). The record is a service-log record like
  `events-index-skipped-lines`; the counts and positions are what a
  maintainer needs to find and repair the line by hand, and the record is
  written at most once per file per read, so a torn line costs one line of
  log per input build and not one per torn line.
- AC-3. **Infra health builds its input over a torn log.** Given a service
  log holding records of the last day, a NUL-only line and a NUL-prefixed
  `telegram connected` record inside the last day, and a NUL-only line older
  than a day, and an action log holding a week's rows and a NUL-only line,
  when `buildInfraHealthInput(d, events, since, now)` runs with `d.log` set
  (the deps gain `log?: (rec: Record<string, unknown>) => void`, which
  `standing/run.ts` passes as `d.log`), then it returns: `service_log` with
  the day's records of spec 064 AC-5's kinds, the recovered record among
  them if its kind qualifies, in file order; `actions` as today; and a new
  field `skipped_lines`, an array with one entry per file read that skipped
  or recovered a line, each `{ file, skipped, recovered, offsets, lines? }`
  (the report's fields without `kind`), empty when nothing was skipped. The
  log received one `jsonl-skipped-lines` record per such file. The service
  log's kinds filter (`LOG_KINDS`) gains `jsonl-skipped-lines`, so the day's
  reports from the other readers (the filer's, the audit's, the action log's)
  reach the agent as well. `schemas/scheduler/infra-health-input.json` lists
  `skipped_lines` as required with the shape above, and the built input
  validates. The run proceeds to the model: a `standing.test.ts` (or
  `standing-wakes.test.ts`) case runs the infra-health agent through
  `runStandingAgent` over such a service log with a scripted adapter and
  asserts the adapter ran and no `standing-error` was logged, which fails on
  `main` before the change with the `Unexpected token '\u0000'` error.
- AC-4. **Infra health knows when a torn line is a finding.**
  `agents/standing/infra-health.md` describes `skipped_lines` beside the
  other input fields and adds one limit: a file in `skipped_lines`, or in a
  `jsonl-skipped-lines` service-log record of the last day, whose same
  offsets appear in two or more reports (this build's and an earlier one's,
  or two earlier ones) is a finding, filed once per file, with `what`
  "torn line(s) in <file>" (the path relative to the state root), the
  offsets, line numbers and counts as `evidence`, `noticed_how` "infra
  health input", and the repair rule in `what` or `evidence`: a NUL prefix
  is removed by hand keeping the record it covers, a NUL-only line is left
  or removed only in a file that no stored offset indexes, and
  `events/*.jsonl` is never edited because `index.sqlite` stores byte
  offsets into it. A single report with no earlier one is not yet a finding
  (a line torn by the crash the scheduler is restarting from is expected
  once). The registry still loads the definition (spec 041) and the prompt's
  other limits are unchanged.
- AC-5. **The action audit and the filer build their inputs over torn
  files.** Given an action log with a NUL-prefixed row and a NUL-only line,
  and a parameter history with a NUL-only line, when `buildAuditInput(paths,
  since, now, log?)` runs (it gains an optional `log`, passed as `d.log` from
  `standing/run.ts`), then `kinds` holds the recovered row under its kind,
  `parameter_history` holds the parseable rows, and the log received one
  report per file. Given a findings queue of five lines whose line 2 is
  NUL-only and whose line 4 is a NUL-prefixed record, and a triage log with
  one NUL-only line and settled rows for refs 1 and 3, when `buildFilerInput`
  runs, then the records offered are refs 4 and 5 (ref 4 recovered, its
  `ref` "4"), ref 2 is never offered, `cursor` is 1 (the cursor stops before
  the hole at line 2, section 2), and `d.log` received one report for the
  queue and one for the triage log. Given the same triage log, when
  `applyFilerResult` reads it, then the read succeeds and the decisions
  apply as today. The queue is read positionally (AC-1) and the triage log,
  action log, parameter history and service log are not. `ActionLog.list()`
  in `src/actions/log.ts` reads through the same reader, logging through a
  `ServiceLog` at `this.paths.serviceLog`, so `markStalePending` at service
  start, `undo` and the `rerun_workflow` check survive a torn action log; a
  test shows `markStalePending` over a log with a NUL-only line settles the
  pending row that follows it. `src/reflection/input.ts` changes only by
  the shared function.
- AC-6. **The service log is read from its tail.** `readRecentJsonLines<T
  extends { at: string }>(path, cutoff: string, opts)` in the new module
  returns the records whose `at` is at or after `cutoff` (an ISO timestamp,
  compared as `Date.parse`), in file order, by reading the file backwards
  from its end in chunks of 64 KiB (`opts.chunkBytes`, overridable by
  tests): each chunk is cut at line boundaries (a line that straddles two
  chunks is parsed once, whole), its lines are parsed as AC-1 does, and the
  read stops after the first whole chunk in which no parsed record has `at`
  at or after the cutoff, or at the start of the file. Records older than
  the cutoff found in the chunks read are dropped; a record lacking a
  parseable `at` is skipped and counted. `buildInfraHealthInput` reads the
  service log this way with the cutoff `now - 24 h`, then applies the kinds
  filter. Given a service log of 1,000 records spanning ten days, written
  with a torn line in the first day and a torn line in the last hour, read
  with `chunkBytes` of 4 KiB, then the result equals the strict filter of
  the whole file over the last day, the report names only the recent torn
  line's offset (the old one was never read), and `lines` is absent from the
  report. Given a file smaller than one chunk, or an empty file, or no file,
  then the result is the same as the whole-file read filtered (the empty
  list for the last two). Given a record newer than the cutoff among older
  ones in an earlier chunk (a clock that went back), then it is returned if
  its chunk was read and silently not if the read had stopped: the test
  pins the rule, not a stronger guarantee.
- AC-7. **The issue's acceptance test.** One test file,
  `tools/scheduler/test/jsonl-torn-line.test.ts`, writes a JSONL file
  containing a NUL-only line and a NUL-prefixed record into a temporary state
  root as the service log, the action log, the parameter history, the
  findings queue and the triage log, and shows that
  `buildInfraHealthInput`, `buildAuditInput` and `buildFilerInput` all
  return, that each recovered record is present in the respective input,
  that each skipped line is absent (and, in the queue, a hole), and that the
  log collected one `jsonl-skipped-lines` record per file with `skipped` 1
  and `recovered` 1. Before the change, the same test fails in all three
  builds with `Unexpected token '\u0000'`.

## 4. Interfaces and files

- `tools/scheduler/src/state/jsonl.ts` (new): `parseJsonLine(line: string):
  { ok: true; value: unknown; recovered: boolean } | { ok: false }` (strips
  leading `\u0000`, parses, requires a non-null object);
  `readJsonLines<T>(path, opts?: { log?; positional?: boolean }): Promise<T[]>`
  (AC-1, AC-2; the positional overload returns `(T | undefined)[]`);
  `readRecentJsonLines<T extends { at: string }>(path, cutoff, opts?: { log?;
  chunkBytes?: number }): Promise<T[]>` (AC-6); the report type
  `SkippedLines = { file: string; skipped: number; recovered: number;
  offsets: number[]; lines?: number[] }` and an `onSkipped?: (r: SkippedLines)
  => void` option so a caller can collect the report into its input (AC-3)
  as well as log it.
- `tools/scheduler/src/filer/input.ts`: `readJsonLines` re-exported from the
  new module (or imports moved); `buildFilerInput` reads the queue
  positionally and both files with `d.log` and collects nothing (AC-5).
- `tools/scheduler/src/filer/apply.ts`: the triage read through the reader
  with `d.log`.
- `tools/scheduler/src/standing/infra-health-input.ts`: `log?` on the deps,
  the tail read of the service log (AC-6), `skipped_lines` in the result
  (AC-3), `LOG_KINDS` gains `jsonl-skipped-lines`.
- `tools/scheduler/src/standing/audit-input.ts`: the fourth parameter `log?`
  (AC-5).
- `tools/scheduler/src/standing/run.ts`: passes `d.log` to both builders.
- `tools/scheduler/src/actions/log.ts`: `list()` through the reader with a
  `ServiceLog` logger (AC-5).
- `schemas/scheduler/infra-health-input.json`: `skipped_lines` (AC-3),
  regenerated or edited as the schema tooling does.
- `agents/standing/infra-health.md`: the input description and the new
  limit (AC-4).
- Tests: `tools/scheduler/test/jsonl.test.ts` (AC-1, AC-2, AC-6),
  `infra-health-input.test.ts` (AC-3), `standing.test.ts` or
  `standing-wakes.test.ts` (AC-3's run), `filer.test.ts` (AC-5's filer
  case), `actions.test.ts` (AC-5's `markStalePending`), a new
  `audit-input` case where the implementer finds it fits (AC-5),
  `jsonl-torn-line.test.ts` (AC-7).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). The change
reads the scheduler's own state files more tolerantly, writes one new kind of
service-log record, adds one field to an agent input and one limit to an
agent prompt, and changes nothing in the sensitive-path list, the security
review's criteria or instructions, what routes a sensitive diff to the
security review, that both reviews must approve, or that a sensitive path
must be listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes, including the design-tree
  check for this spec's `Parent:` line and the Children entry.
- AC-1, AC-2, AC-6: `jsonl.test.ts` covers the line kinds named, the
  positional read, the report's fields and once-per-read rule, and the tail
  read's chunk rule with a small `chunkBytes`.
- AC-3: `infra-health-input.test.ts` builds the input over the torn files and
  validates it against the schema; the runner case shows the adapter ran.
- AC-4: `grep -n skipped_lines agents/standing/infra-health.md` finds the
  description and the limit; the registry test of spec 041 still loads the
  file.
- AC-5: the filer, audit and action-log cases named.
- AC-7: `jsonl-torn-line.test.ts` passes on the branch; checked out on
  `main` before the change (the test file copied over), each of its three
  builds throws `Unexpected token '\u0000'`.
- Live, after the implementation merges: the next six-hourly infra-health
  run reaches the model (an `agent.run` event with outcome `ok` for
  `infra-health`), the service log shows no `standing-error` for it, and,
  while `events/2026-11.jsonl` line 13167 stays torn, the service log shows
  no `jsonl-skipped-lines` for the service log itself (its line 38550 was
  repaired by hand) and the index's `events-index-skipped-lines` behaviour is
  unchanged.

## 6. Open decisions

None.
