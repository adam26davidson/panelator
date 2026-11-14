# 058. The two loop tests that wait a fixed 50 ms for a chain to start poll for it instead

Status: written 2026-11-14 from the delivery-system design for issue #111;
specs derived from that design need no maintainer approval (design section 11).
Class: debt. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops, so a required check that fails for
a reason other than the change under test costs a fix stage and a rescue for
nothing) and section 10 ("Small work skips layers": a debt spec hangs
directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-1, AC-2, AC-5 and
AC-31 (the behaviours the two tests cover; the tests' assertions about them
do not change). This spec marks no earlier text: it changes how two tests
wait, not what any spec promises.

## 1. Goal

Two tests in `tools/scheduler/test/loop.test.ts` tick the scheduler, wait a
fixed 50 ms and then assert that the stub chain started (`started` equals
`[3]`, `started` equals `[7]`). The scheduler starts a chain from `tick`
without awaiting it (`this.#start(c)`, `tools/scheduler/src/service/loop.ts`
line 712 on `main`; the resume of a claim found on disk takes the same
path), so the test can only wait for it. A fixed wait is a bet on the
machine's speed: the same shape in the `MAX_CHAIN_FAILURES` test lost that
bet in CI (`expected [] to deeply equal [ 7 ]`, recorded in issue #38's fix
stage) while the design package's Storybook build and Chromium render ran
in a parallel worker, and PR #104 changed that test to poll. Since spec 054
the render test (`tools/design-stage/test/render.test.ts`) runs in every
`pnpm test`, so the load that exposed it is present in every CI run, and
every `pnpm test` of the chain's implement and fix stages.

After this spec, each of the two tests waits in a bounded poll until the
chain has started and has left the scheduler's active set, and then asserts
exactly what it asserts today. A slow machine makes the test slower, not
red; a scheduler that never starts the chain still fails the test, at the
poll's bound, with the same assertion.

### Where the sleeps are (on `main` at the time of writing)

- `tools/scheduler/test/loop.test.ts` line 159, in "claims only as many
  issues as there are slots, in rank order, and labels the rest of the
  decisions (AC-1, AC-2, AC-5)": `await new Promise((r) => setTimeout(r, 50));`
  before `expect(started).toEqual([3]);`.
- `tools/scheduler/test/loop.test.ts` line 297, in "resumes a claim found on
  disk after a restart (AC-31)": the same line before
  `expect(started).toEqual([7]);`.
- The merged poll this spec copies is at line 320, in the
  `MAX_CHAIN_FAILURES` test:
  `for (let w = 0; w < 200 && (errors.length < i || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25));`.

The issue cites lines 124, 246 and 268; the file has grown since, and the
three lines are the ones above.

## 2. Out of scope

- The behaviour of `Scheduler.tick`, `#start`, `active` and the stub
  `driveChain` of the test's `setup`: unchanged. This spec touches no file
  under `tools/scheduler/src/`.
- The other fixed waits in `tools/scheduler/test/`: the 100 ms sleeps in
  "keeps the failure count across a restart" (loop.test.ts lines 346, 352
  and 357), the 100 ms `settle()` helper (line 442) and its uses, the 20 ms
  sleep after `finish()` in the standing-agent slot test (line 151), the
  10 ms sleep in the watchdog test (line 80), and the `sleep` of
  `auth.test.ts` and `telegram.test.ts`. The issue names the two 50 ms
  sleeps of the `started` shape; the others are the same family and are
  recorded as a finding, not changed here. *(agent's call: the issue's scope
  is the deliverable; widening it to every fixed wait would make the PR a
  different change from the one the filer verified.)*
- The bounded loops that already poll (`loop.test.ts` lines 94, 320 and
  1384; `e2e.test.ts`; `standing-wakes.test.ts`;
  `helpers/e2e-routes.ts` line 287): unchanged.
- A shared polling helper exported for every scheduler test file: not
  required. The implementation may add a local helper inside
  `loop.test.ts` (section 4) and may not add a new file under
  `tools/scheduler/src/`.
- The vitest configuration, the per-test timeouts (`30_000`) and what
  `pnpm test` runs: unchanged (`**/vitest.config.*`, `package.json` and
  `AGENTS.md` are sensitive paths and are not touched).
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch. "A bounded
poll" means a loop that sleeps a short fixed interval between checks of a
condition, gives up after a fixed number of iterations whose total is at
least 2 s and at most the test's timeout, and is followed by the test's
assertions unchanged, so that a condition never met fails the test on those
assertions. The poll at `loop.test.ts` line 320 (200 iterations of 25 ms) is
the model.

- AC-1. **The slot test polls for the started chain.** Given the test
  "claims only as many issues as there are slots, in rank order, and labels
  the rest of the decisions (AC-1, AC-2, AC-5)", when it has asserted
  `t.claimed` equals `[3]`, then it waits in a bounded poll until `started`
  is non-empty and `s.active` is 0, and then asserts, as on `main`,
  `started` equals `[3]`, the claims on disk are `[3]`, the label POST for
  issue 3 carried `in-progress`, and a second tick claims nothing. The line
  `await new Promise((r) => setTimeout(r, 50));` is gone from the test.
- AC-2. **The restart test polls for the resumed chain.** Given the test
  "resumes a claim found on disk after a restart (AC-31)", when it has
  ticked, then it waits in a bounded poll until `started` is non-empty and
  `s.active` is 0, and then asserts, as on `main`, `started` equals `[7]`.
  The line `await new Promise((r) => setTimeout(r, 50));` is gone from the
  test.
- AC-3. **The polls are bounded and the assertions still bite.** Given
  either test with its `driveChain` replaced by one that never records the
  issue (for example a drive that returns the claim untouched), when the
  test runs, then it fails on `expect(started).toEqual([...])` within its
  30 s timeout; it does not hang. This is a property of the poll's shape
  (AC-1, AC-2); the implementation need not add a test for it, and must not
  weaken either assertion to make the poll pass.
- AC-4. **Nothing else moves.** Given the implementation PR's diff, then it
  changes only `tools/scheduler/test/loop.test.ts`; every other test in that
  file, every assertion of the two tests other than the removed sleeps, the
  tests' names and their timeouts are unchanged; no file under
  `tools/scheduler/src/` changes; and no text marked `(maintainer answer,
  question #<id>)` changes anywhere. `grep -n "setTimeout(r, 50)" tools/scheduler/test/loop.test.ts`
  prints nothing.
- AC-5. **The test suite passes.** Given the change, when `pnpm test` runs
  from the repository root and `pnpm -F @panelator/scheduler typecheck`
  runs, then both pass, and `pnpm -F @panelator/scheduler test -- loop`
  (or vitest's equivalent file filter) passes the two tests of AC-1 and
  AC-2.

## 4. Interfaces and files

No schema, prompt or source change. The implementation PR edits one file:

- `tools/scheduler/test/loop.test.ts`: in the two tests of AC-1 and AC-2,
  replace the 50 ms sleep with a bounded poll of the shape at line 320, on
  the condition `started.length === 0 || s.active > 0` (keep waiting while
  either holds), for example
  `for (let w = 0; w < 200 && (started.length === 0 || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25));`.
  The implementation may instead define one local helper near `settle`
  (line 442), such as
  `const untilStarted = async (started: number[], s: Scheduler) => { for (let w = 0; w < 200 && (started.length === 0 || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25)); };`,
  and call it from both tests. *(agent's call: either form; the inline loop
  matches the merged poll exactly and the helper names the intent. The
  condition includes `s.active` so the test ends with no chain still
  settling in the background, as the line 320 poll does.)*

The spec PR itself adds
`specs/058-loop-test-polls-for-the-started-chain/spec.md` and lists it
under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The change
is confined to how two unit tests wait; it touches no gate, bound, label
rule, permission or token handling, and it weakens no assertion (AC-3). This
spec plans no change to the charter, to a protected maintainer decision, to
the sensitive-path list, to the security review criteria or instructions,
or to what decides that a sensitive diff gets the security review, that
both reviews must approve, or that a sensitive path must be listed in the
spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-5).
- `grep -n "setTimeout(r, 50)" tools/scheduler/test/loop.test.ts` prints
  nothing; `grep -c "started.length === 0" tools/scheduler/test/loop.test.ts`
  prints 1 (a helper) or 2 (two inline loops) (AC-1, AC-2, AC-4).
- `git diff --stat origin/main` on the implementation branch lists only
  `tools/scheduler/test/loop.test.ts` (AC-4).
- Manual check of AC-3, once, by the implementer: with the stub drive in
  `setup` temporarily returning the claim without pushing to `started`, the
  two tests fail on `expect(started).toEqual(...)` in about 5 s each, not
  at the 30 s timeout; the stub is then restored before commit.
- Live check: the next CI runs of scheduler PRs show no failure of the two
  tests with `expected [] to deeply equal [ 3 ]` or `[ 7 ]`.

## 6. Open decisions

None.
