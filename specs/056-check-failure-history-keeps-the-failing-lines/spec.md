# 056. The history entry of a failed check keeps the failing lines, not the head of the log tail

Status: written 2026-11-12 from the delivery-system design for issue #109;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the rescue runs "with the full history of attempts, results and
review findings"; an abandoned issue is "labelled `abandoned` with the full
record" and a finding is filed), section 10 ("Small work skips layers") and
section 13 (the history's shape is the builder's);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-14 (a failed check
starts a fix stage "with the failing check's log excerpt as input");
[006-no-human-stops](../006-no-human-stops/spec.md) AC-5 (the abandonment
comment and the finding carry the ledger's history) and AC-7 (the history
"gains an entry on every ... check failure"; "each entry is capped in
length, and the last 20 are kept"). This spec marks no earlier text: spec
006 AC-7 fixes the cap, not which end of a check's excerpt the cap keeps,
and spec 001 AC-14's fix input is unchanged.

## 1. Goal

When a required check fails, the history entry the chain records holds the
lines that say what failed: the failing test's `FAIL` block and vitest's
summary, or the compiler's or linter's error lines. Every later reader of
the history (the fix rescue, the re-plan's plan stage, the spec stage in
`revise` mode, the abandonment comment and the finding the filer reads) sees
the cause, as the design's "full history" and "full record" intend. The fix
stage's own input stays the whole excerpt, cleaned of the noise that made
the entry useless.

### What is wrong today (spec agent's reading of the code, 2026-11-12)

`GitHubClient.jobLogExcerpt` (`tools/scheduler/src/github/client.ts` lines
177 to 181 on `main`) returns the last 200 non-empty lines of the failed
job's raw log. The driver prefixes the check's name
(`verifyEvent`, `tools/scheduler/src/chain/driver.ts` line 919) and the
machine records `A required check failed:\n<name>\n<excerpt>` both as the
fix input and as a history entry (`verifyChecks`,
`tools/scheduler/src/chain/machine.ts` lines 566 to 569). `note` clips every
entry with `clip`, which keeps the first `HISTORY_ENTRY_MAX` (4000)
characters (lines 51 and 117 to 119).

The raw log is wide and ends in noise. Each line carries GitHub's 29-character
timestamp (`2026-11-01T08:32:02.5581118Z `), and vitest's output carries
ANSI colour sequences, so a passing-test line runs about 200 characters.
After vitest's `Test Files`/`Tests` summary and pnpm's `ELIFECYCLE` line,
the job's `##[error]Process completed with exit code 1.` is followed by
some 25 lines of post-job cleanup (`Post job cleanup.`, `git config`
commands, `Cleaning up orphan processes`, a Node.js deprecation warning).
The failure block (`⎯⎯⎯ Failed Tests 1 ⎯⎯⎯`, `FAIL <file> > <test>`, the
error, the stack, the summary) therefore sits some 40 lines before the end
of the tail, after a hundred or more `✓` lines.

The head clip keeps about 20 of those `✓` lines and stops mid-line. The
ledgers show it: `escalations/38.json` entries 11 and 13 and
`escalations/39.abandoned-2026-11-01T09-03-10-729Z.json` entry 0 are each
exactly 4000 characters, begin `A required check failed:\ntest\n2026-11-01T…
✓ Scheduler.tick: …` and end inside a passing test's name. Issue #39's
abandonment comment quotes the same text; the plan stage of issue #38
reported that "the earlier CI failure recorded in this issue's history was
truncated before its cause". The fix run of issue #39
(`runs/39-fix-1-…/input.json`) got the whole 32 000-character excerpt, with
the failure block, which is why the fix stage itself could work while every
later stage could not.

### The fix

Three changes, each on its own enough to help and together enough to hold
the cause in 4000 characters *(agent's call: all three; the issue offers
them as alternatives, and they are cheap, independent and compatible)*:

1. **Clean the excerpt where it is fetched.** `jobLogExcerpt` strips ANSI
   escape sequences and GitHub's leading timestamps, drops lines that are
   blank once cleaned, cuts the post-job cleanup (everything after the last
   `##[error]` line), and only then keeps the last 200 lines. The fix stage
   reads a plainer excerpt whose 200 lines are all the job's own output.
2. **Build the check's history entry from the first failure marker.** The
   machine records, after the `A required check failed:` header and the
   check's name, the excerpt from its first line that marks a failure
   (vitest's `FAIL`, `×` and `⎯⎯⎯` rules, `##[error]`, `ELIFECYCLE`,
   `Error:`/`<Name>Error:`, `error TS…`, `ERR_…`) to its end. The `✓` lines
   before it are not recorded; the fix input still has them.
3. **Clip the entry from the right end.** When the entry still exceeds the
   cap, an entry cut at a marker keeps its head (the `FAIL` line, the
   error and the start of the stack: the cause) and an entry with no marker
   keeps its tail (where every tool prints its summary), and either says
   how much it left out. `HISTORY_ENTRY_MAX` stays 4000 and every other
   entry is clipped as today.

No ADR: the change is to the shape of one history entry, reversible in one
PR, and the three parts have one clearly right combination once the real
log's shape is in view (delivery-system design section 3, a decision with
one clearly right answer proceeds on the agent's judgement).

## 2. Out of scope

- `HISTORY_ENTRY_MAX` (4000) and `HISTORY_MAX_ENTRIES` (20): unchanged. The
  `pnpm test` assertion that they equal `[4000, 20]` stays.
- How any other history entry is clipped (a failed stage's reason, a scope
  violation, a `changes_requested` review, a rebase conflict, a chain error):
  `clip` keeps their head as today. The `close_pr` comment's clip of the
  escalation reason: unchanged.
- The fix stage's input text beyond the cleaning of AC-1: still
  `A required check failed:\n<name>\n<excerpt>`, with the whole 200-line
  excerpt, so spec 001 AC-14 holds as written.
- The number of lines fetched (200), the GitHub endpoint, the decoding of a
  binary log body and the `(no log for <name>)` fallback: unchanged.
- Recorded ledgers and past abandonment comments: entries already clipped
  are not rewritten.
- The rendering of the abandonment comment (numbering, indentation, the
  50 000-character budget, `@` replaced by `(at)`) and of the finding's
  evidence: unchanged. They carry the new entry as they carry any entry.
- The `history` field of the stage input (`buildInput` joins the entries
  with blank lines): unchanged.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch and the unit
tests of `tools/scheduler/test/`. "The real shape" of a failed `test` job's
log means the shape of issue #39's: timestamped lines with ANSI colour
sequences, more than 4000 characters of `✓` lines, then vitest's
`⎯⎯⎯ Failed Tests 1 ⎯⎯⎯` rule, a `FAIL <file> > <test>` line, an error with
its stack (`❯` lines), the `Test Files`/`Tests`/`Duration` summary, pnpm's
`ELIFECYCLE  Test failed.` line, `##[error]Process completed with exit code
1.`, and then post-job cleanup lines (`Post job cleanup.`, `[command]/usr/bin/git
…`, `Cleaning up orphan processes`, `##[warning]…`).

- AC-1. **The excerpt is cleaned before it is cut to 200 lines.** Given a
  job log of the real shape, when `jobLogExcerpt(jobId)` returns, then every
  line of the excerpt is free of ANSI escape sequences (CSI sequences: ESC,
  `[`, parameter and intermediate bytes, a final byte in `@` to `~`) and of
  the leading GitHub timestamp (`<ISO date>T<time>Z` followed by one space);
  no line is blank or whitespace only; the last line is the log's last
  `##[error]` line (`##[error]Process completed with exit code 1.`) and no
  post-job cleanup line follows it; and the excerpt holds at most the
  requested number of lines (200 by default), counted after that cleaning,
  so that all of them are the job's own output. Given a log with no
  `##[error]` line, then nothing is cut from its end. Given the two logs of
  the existing `jobLogExcerpt` tests (300 plain `line <i>` lines, as text and
  as an octet stream), then the excerpt is still the last 50 lines ending in
  `line 299`.
- AC-2. **The history entry starts at the first failure marker.** Given a
  `checks` event with `status: "failed"` whose `log` is `<name>\n<excerpt>`
  with the excerpt of the real shape (cleaned as AC-1), when the machine
  processes it, then the new history entry begins
  `A required check failed:\n<name>\n`, continues with the excerpt's first
  marker line and everything after it, and contains no `✓` line. A marker
  line is one that, after leading whitespace, begins with `FAIL` as a word,
  `×`, `✗`, `✖`, three or more `⎯`, `##[error]`, `ELIFECYCLE`, `ERR_`,
  `npm ERR!`, `Error:` or `<Name>Error:` (a word ending in `Error` followed
  by a colon, such as `AssertionError:` or `TypeError:`), or that contains
  `error TS<digits>:` (tsc). The implementation may add markers for a tool
  CI runs; it may not drop one of these. Given an excerpt with no marker
  line, then the entry holds the whole excerpt after the header and the
  name, subject to AC-3. Given the existing tests' logs (`L<i>`, `FAIL
  x.test.ts`, `FAIL`), then the entries hold them as today (`L5` ends the
  oldest kept entry; `FAIL x.test.ts` is in the entry and in the fix input).
- AC-3. **The clip keeps the cause.** Given the entry of AC-2 would exceed
  `HISTORY_ENTRY_MAX` characters, then it is at most `HISTORY_ENTRY_MAX`
  characters and: when a marker was found, it keeps the header, the name and
  the first characters from the marker onward, and its last line is
  `[… <n> characters of the excerpt omitted]`; when no marker was found, it
  keeps the header, the name, a line `[… <n> characters of the excerpt
  omitted]` and the last characters of the excerpt, ending with the excerpt's
  last line. `<n>` is the count of excerpt characters not in the entry.
  Given the entry fits the cap, then it carries no such line. Given the
  excerpt of the real shape with the `FAIL` block, error, stack and summary
  under 3900 characters, then the entry holds the `FAIL` line, the error
  line, the `Test Files` summary line, the `ELIFECYCLE` line and the
  `##[error]Process completed` line, uncut.
- AC-4. **The fix input is the whole excerpt.** Given the event of AC-2,
  then the `run_stage` action for `fix` carries `fixInput` equal to
  `A required check failed:\n<log>` with the whole `log`, and
  `pendingFixInput` is the same text, as on `main`; the marker cut and the
  omission line of AC-2 and AC-3 apply to the history entry only.
- AC-5. **Later readers see the failing lines.** Given a chain whose history
  holds the entry of AC-2 and AC-3, when the chain abandons the issue, then
  the abandonment comment and the abandonment finding's `evidence` contain
  the `FAIL` line of that entry (they render the history as on `main`);
  and the stage input's `history` of the next stage contains it (`buildInput`
  joins the entries as on `main`). Given a ledger read back on a new claim,
  then the entry is kept as written (it is already within the cap).
- AC-6. **Nothing else moves.** Given the implementation PR's diff, then
  `HISTORY_ENTRY_MAX` is 4000 and `HISTORY_MAX_ENTRIES` is 20; the clip of
  every history entry not made by a `checks` failure keeps its head as on
  `main`; `clip(reason)` in the `close_pr` comment, `abandonmentComment`,
  the `finding` action of `abandon`, `initialChainState`'s ledger trim and
  `ledgerOf` are unchanged in behaviour; the `GitHubClient` methods other
  than `jobLogExcerpt` are unchanged; no text marked `(maintainer answer,
  question #<id>)` changes anywhere; and no gate, bound, label rule or
  permission of specs 001 and 006 changes (security criterion 5).
- AC-7. **The test suite covers it and passes.** Given the change, when
  `pnpm test` runs from the repository root and
  `pnpm -F @panelator/scheduler typecheck` runs, then both pass, and the
  suite has tests for AC-1 (a log fixture of the real shape with timestamps,
  ANSI sequences and post-job lines; the two existing tail tests kept), AC-2
  and AC-3 (the fixture's excerpt through the machine: the entry has the
  `FAIL` and `##[error]` lines and no `✓` line and is within the cap; an
  over-long excerpt with a marker ends in the omission line; an over-long
  excerpt without a marker begins with it after the name and ends with the
  excerpt's last line), AC-4 and AC-5 (the fix input is whole; the
  abandonment comment of a chain with that entry contains the `FAIL` line).

## 4. Interfaces and files

No schema or prompt change. `jobLogExcerpt(jobId, lines = 200): Promise<string>`
keeps its signature; the `checks` event, `ChainState.history` and the
stage input keep their shapes. The implementation PR edits or adds:

- `tools/scheduler/src/github/job-log.ts` (new): a pure
  `cleanJobLog(raw: string, lines: number): string` that splits on `\n`,
  strips CSI sequences (`/\x1b\[[0-9;?]*[ -\/]*[@-~]/g`) and the leading
  timestamp (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/`), drops
  lines blank after that, cuts after the last line starting with
  `##[error]` when there is one, and joins the last `lines` lines (AC-1).
  *(agent's call: a module beside the client, so the client stays a thin
  wrapper over the API and the cleaning is unit-tested without a mock
  server.)*
- `tools/scheduler/src/github/client.ts`: `jobLogExcerpt` decodes the body as
  today and returns `cleanJobLog(text, lines)` (AC-1).
- `tools/scheduler/src/chain/machine.ts`: an exported
  `checkFailureEntry(log: string): string` that takes the event's `log`
  (`<name>\n<excerpt>`), returns the entry of AC-2 and AC-3 within
  `HISTORY_ENTRY_MAX`, and is what `verifyChecks` passes to `note` while the
  fix input stays `A required check failed:\n${event.log ?? "(no log
  excerpt)"}` (AC-2 to AC-4); a `FAILURE_MARKER` regular expression (for
  example
  `/^\s*(FAIL\b|[×✗✖]|⎯{3,}|##\[error\]|ELIFECYCLE|ERR_|npm ERR!|Error:|\w+Error:)|\berror TS\d+:/`)
  beside it; the omission line `[… <n> characters of the excerpt omitted]`.
  `clip`, `note`, `HISTORY_ENTRY_MAX` and `HISTORY_MAX_ENTRIES` are
  unchanged.
- `tools/scheduler/test/client.test.ts` or a new
  `tools/scheduler/test/job-log.test.ts`: the AC-1 tests on a fixture of the
  real shape (inline or under `tools/scheduler/test/fixtures/`, built from
  the cleaned tail of issue #39's failed `test` job or a faithful imitation
  of it; the ledger quoted in section 1 shows the exact line format).
- `tools/scheduler/test/chain.test.ts`: the AC-2 to AC-5 tests, added to the
  "chain: history (AC-7)" and abandonment groups; the existing assertions
  stay.

The spec PR itself adds
`specs/056-check-failure-history-keeps-the-failing-lines/spec.md` and lists
it under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The change
alters what text one history entry holds and how a log is cleaned; it
touches no gate, bound, label rule, permission or token handling, and the
cleaned excerpt reaches the same readers as today. This spec plans no change
to the charter, to a protected maintainer decision, to the sensitive-path
list, to the security review criteria or instructions, or to what decides
that a sensitive diff gets the security review, that both reviews must
approve, or that a sensitive path must be listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-7).
- `grep -n "cleanJobLog" tools/scheduler/src/github/client.ts` prints the
  call in `jobLogExcerpt`; `grep -n "checkFailureEntry\|FAILURE_MARKER" tools/scheduler/src/chain/machine.ts`
  prints the definitions and the one use in `verifyChecks` (AC-1, AC-2).
- `grep -n "HISTORY_ENTRY_MAX = 4000\|HISTORY_MAX_ENTRIES = 20" tools/scheduler/src/chain/machine.ts`
  prints both; `grep -n "const clip = " tools/scheduler/src/chain/machine.ts`
  prints the unchanged head clip (AC-6).
- Live check after deploy: the next chain whose required check fails writes
  an `escalations/<issue>.json` entry that begins `A required check failed:\ntest\n`
  followed within a few lines by a `FAIL`, `×`, `⎯⎯⎯` or `##[error]` line,
  contains no `\u001b[`, no `Z ✓` and no `Post job cleanup`, and is at most
  4000 characters; the fix run's `input.json` `fix_input` holds the whole
  excerpt ending at the `##[error]Process completed` line (AC-1 to AC-4).

## 6. Open decisions

None.
