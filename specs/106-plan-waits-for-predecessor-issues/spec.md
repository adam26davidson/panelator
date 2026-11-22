# 106. A plan can say the issue waits for other issues: the scheduler blocks it, releases the claim with no bound spent, and the children scan lifts the block

Status: written 2026-11-22 from the delivery-system design for issue #255;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-19 (a plan
result of `waiting` is neither ready nor a gap),
[077-plan-names-its-implementation-profiles](../077-plan-names-its-implementation-profiles/spec.md)
AC-2 (a `waiting` plan names no domain and skips the profile check),
[066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md)
AC-7 (whose blocks the scan's pass lifts, and whose marker comments count) and
[031-design-files-children](../031-design-files-children/spec.md) AC-6 (a
hand-set `blocked` with the maintainer's marker comment is lifted) and
[078-children-scan-repairs-blocked-comment](../078-children-scan-repairs-blocked-comment/spec.md)
AC-1 (its repair skips an issue that waits), marked as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work; "every other
blocker is resolved by agents") and section 10 ("Small work skips layers": a
tooling spec hangs directly off a top design);
[ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
("their issues are filed with the `blocked` label, which the shortlist skips,
and each loses it when its predecessor merges");
[ADR 0015](../../docs/decisions/0015-host-outage-pauses-scheduler.md) (only
an issue's own failures spend its bounds);
[001-scheduler-core](../001-scheduler-core/spec.md) section 7 (the
shortlist's eligibility rules, unchanged: `blocked` is skipped);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-1, AC-7 and AC-19 (the
bounds, the ledger, the plan's verdicts);
[031-design-files-children](../031-design-files-children/spec.md) AC-3 and
AC-6 (when the children scan runs, its done test and its unblocking);
[066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md)
AC-3, AC-6 and AC-7 (the blocked-by marker comment, the re-point on a
rewrite and the lift, all reused here);
[076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-2
(model-written text cannot carry a scheduler marker);
[077-plan-names-its-implementation-profiles](../077-plan-names-its-implementation-profiles/spec.md)
AC-2 (the profile check that today runs before the verdict is read);
[051-console](../051-console/spec.md) section 4 and
[069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
section 1 (both record this gap).

## 1. Goal

When the plan stage finds that an issue's spec is right but cannot be built
yet, because work carried by other issues is not on `main`, the issue waits
instead of failing. The plan returns a third verdict, `waiting`, naming the
issues it waits for. The scheduler labels the issue `blocked`, posts spec
066's blocked-by marker comment, and releases the claim without counting a
plan failure, a spec answer, a re-plan or a rescue. The children scan, which
already lifts the filer's blocked-by blocks, lifts this one when every named
issue is done, and the shortlist claims the issue again; its chain starts at
plan, because its spec is on `main`. A `blocked` label set by hand is lifted
the same way when the maintainer's comment carries the same marker.

### What is wrong today (spec agent's reading, 2026-11-22)

- The plan's verdicts are `ready`, `spec_gap` and an escalation
  (`schemas/scheduler/plan-result.json`). A `spec_gap` that only means "not
  yet" is answered once by the spec stage, which can change nothing, and the
  second one is a bound hit (spec 006 AC-19, `stageOk` case `plan` in
  `tools/scheduler/src/chain/machine.ts`). Issue #101 went through at least
  six plan runs, a rescue, a re-plan and a spec revision to abandonment on
  2026-11-12 this way.
- The driver checks the plan's `domain` against the implementation profiles
  before the machine reads the verdict (`stageEvent` case `plan` in
  `tools/scheduler/src/chain/driver.ts`, spec 077 AC-2), so a plan whose
  missing prerequisite is the profile itself fails whatever it returns.
- Code applies `blocked` only to a planned child (spec 031 AC-5) and to an
  issue the filer files (spec 066 AC-3), and lifts it only on a bot-authored
  issue with the bot's marker comment (`liftFilerBlocks` in
  `tools/scheduler/src/filer/blocked.ts`). The plan stage has no shell, so
  it cannot set the label either (run `101-plan-2-20261112T081118-fallback`
  tried).
- The blocks set by hand on #37, #94, #95 and #101 were each lifted by the
  maintainer by hand (the last on 2026-11-21, read from GitHub while writing
  this spec). No open issue carries a hand-set `blocked` today, so nothing
  has to be converted; what is missing is a way for the next one to lift
  itself.

### The fix

1. **The plan can return `waiting`.** `{ "verdict": "waiting", "waits_for":
   [<issue numbers>], "reason": "<one sentence>", "findings": [] }`, with no
   domain and no tasks. To name the numbers without a shell, the plan's
   prompt gains the list of open issues with their `Spec:` lines.
2. **The scheduler checks the numbers and blocks the issue.** A number whose
   issue is done, does not exist, is closed with `abandoned` or is the issue
   itself is dropped. With at
   least one left, the issue gets the blocked-by comment and `blocked`,
   loses the claim label, and the claim is released. No bound is spent; the
   ledger counts the wait.
3. **A wait that cannot be a wait is a spec gap.** When every number is
   dropped, or the issue has already waited three times, the result is
   handled as a `spec_gap` with a reason that says so, down the existing
   path (spec 006 AC-19).
4. **The children scan lifts it.** Spec 066's pass reads every open issue
   carrying `blocked`, whoever wrote the issue, and a blocked-by marker
   comment counts when the bot or the maintainer posted it.

*(agent's call)* The wait is the label, not a parked chain. Spec 060's
parked chain (`blocked.json`) keeps a worktree and a PR alive for a condition
on `main`'s checks; a plan that waits has no PR and nothing to keep, and the
label is what ADR 0004, spec 029 and spec 066 already use for "not before its
predecessor", with the done test, the marker, the lift and the re-point on a
rewrite written and tested. Reusing them means one kind of block on GitHub,
visible on the issue, that survives a scheduler restart with no state file.
The predecessors are issue numbers, not paths on `main`, for the same reason
as spec 066: the lift exists for them, and an issue that is abandoned or
rewritten is followed (spec 066 AC-6), where a path nobody is building would
wait for ever unseen. A prerequisite no open issue stands for is not a wait:
the plan records a finding (the filer can file it) and returns `spec_gap`,
and the spec stage, which has a shell, either absorbs the work (as issue
#131 did) or names the issue that carries it. The verdict belongs to the
plan because the plan is the stage that reads `main` at build time; the spec
stage's part is to say in the spec what it needs. Cheap to reverse; no ADR
(design section 3, item 2).

## 2. Out of scope

- A wait returned by any stage other than plan (implement, fix, review,
  spec, design). An implement run that finds a prerequisite missing fails
  and is re-planned as today, and that plan can wait.
- Waiting on a condition no issue stands for (a path, a milestone, a text
  condition like spec 066's `blocked_until`); see the call above.
- Changing what the shortlist skips or how it ranks (spec 001 section 7,
  `select.ts`).
- Lifting a hand-set `blocked` that has no marker comment: nothing parses
  free text, and it is lifted by hand as today.
- Re-pointing a waiting issue that the bot did not author when the filer
  rewrites its predecessor: spec 066 AC-6 reads the bot's open issues only
  (spec 037). Such an issue is handed back by the pass of AC-6 once the
  predecessor is closed with `abandoned`, and its next plan decides again.
- Spec 060's block on `main` (`blocked.json`, `block.started`), unchanged.
- The profile check for `ready` and `spec_gap` plans (issue #145), and the
  `web-ui` profile itself (issue #206, merged).
- Changing spec 051's or spec 069's text: both describe the gap "until that
  exists", which this spec ends.

## 3. Acceptance criteria

"Given" states use the fakes of the existing tests:
`tools/scheduler/test/chain.test.ts` (the machine),
`tools/scheduler/test/driver.test.ts` (a temporary state directory and a
mocked GitHub client), `tools/scheduler/test/children.test.ts` (the scan's
mocked `ChildrenGh`) and `tools/scheduler/test/schema.test.ts`. "Done" means
closed and not labelled `abandoned` (`isDone`, spec 031). "The bot" is the
App bot login; "the maintainer" is `cfg.maintainer`. The marker is spec
066's `<!-- panelator-blocked-by:<a>,<b> -->` (numbers ascending).

**The verdict**

- AC-1. **The schema has a third verdict.** Given
  `schemas/scheduler/plan-result.json`, then
  `{ "verdict": "waiting", "waits_for": [37, 94], "reason": "spec 022's reserveSpend is not on main", "findings": [] }`
  validates: `waits_for` is an array of integers at least 1, `minItems` 1,
  `uniqueItems` true; `reason` is a string of `minLength` 1; both are
  required with `waiting`. Given a `waiting` result that carries `domain`,
  `tasks`, `questions` or `escalation`, or lacks `waits_for` or `reason`,
  then it is invalid. Given a `ready` or `spec_gap` result that carries
  `waits_for` or `reason`, then it is invalid. Every result that validates
  on `main` today still validates. `PlanResult` in
  `tools/scheduler/src/types.ts` gains the variant. A schema test asserts
  the accept and each reject.
- AC-2. **The plan is told when to wait and whom it can name.** Given
  `agents/stages/plan.md`, then it shows the `waiting` shape of AC-1 beside
  the `ready | spec_gap` shape and says, in these words or words that keep
  them: return `waiting` when the spec is right as written but cannot be
  built yet because work it needs is not on `main` and open issues carry
  that work; name those issues in `waits_for`, taking the numbers only from
  the open-issue list in this prompt or from the spec's own text, never a
  guess; the scheduler labels the issue `blocked`, releases it at no cost to
  its bounds, and claims it again when every named issue is done; when no
  open issue carries the missing work, record a finding that says what is
  missing and return `spec_gap`; never return `spec_gap` or a failed plan
  for something that only needs waiting. The prompt has a placeholder
  `{{open_issues}}` under a line `Open issues:`. Given the driver builds the
  input of a plan run, then `open_issues` holds one line per open issue
  other than the issue itself whose author is the bot or the maintainer,
  ascending by number: `#<n> <title>`, then ` [blocked]` when it carries
  that label, then ` Spec: <path>` when its body has a `Spec:` line; each
  title is passed through `neutraliseMarkers`, has its line breaks removed
  and is cut to 120 characters. The listing is one
  `listIssues({ state: "open", labelEvents: false })` call per plan run.
  Given the call fails, then the value is
  `(the open issues could not be listed)`, the failure is logged and the
  plan runs. Given any other stage, then no listing is made and the
  placeholder, absent from its prompt, is not needed. `StageInput` in
  `tools/scheduler/src/stages/prompt.ts` and
  `schemas/scheduler/stage-input.json` gain the optional `open_issues`
  string. The test that keeps the plan prompt in step (spec 077 AC-4) also
  pins `"verdict": "waiting"`, `waits_for` and `{{open_issues}}`.

**Blocking**

- AC-3. **A wait blocks the issue and releases the claim; no bound is
  spent.** Given a plan run whose result is `waiting` with `waits_for`
  `[94, 37]`, then the driver does not run the profile check (the result
  has no domain; spec 077 AC-2 as amended), lists all issues once
  (`listIssues({ state: "all", labelEvents: false })`) and sorts the
  numbers: a number equal to the issue's own, a number absent from the
  listing and a number whose issue is done are dropped, each with its cause;
  a number whose issue is closed with `abandoned` is dropped too (an
  abandoned issue stays open until the filer's re-triage closes it, by
  `rewrite` or `close`, and a rewrite re-points only the blocks that exist
  at that moment, spec 066 AC-6, so a block named on a closed abandoned issue
  would never be re-pointed); only a number whose issue is open (one open
  with `abandoned` still has its re-triage ahead) is kept. The `stage_ok` event for `plan`
  carries `waits: { kept: number[]; dropped: { issue: number; why: "self" |
  "unknown" | "done" | "abandoned" }[] }`. Given `kept` is `[37, 94]` and the chain has
  waited fewer than `MAX_WAITS` (3) times, then the machine, after settling
  the plan as it does for `ready` (the rescue, decide input and answer are
  spent), adds the history entry
  `plan: waiting for #37, #94: <reason>`, sets the ledger's `waits` one
  higher, and returns, in this order: the closes a release makes (a parked
  issue PR is closed with its comment, spec 006 AC-21); a new action
  `{ type: "wait_for", issues: [37, 94], reason }`; and
  `{ type: "release", reason: "waiting on predecessors", savePatch: true }`,
  with the state's stage `released`. `planFailures`, `specAnswers`,
  `replans`, `rescues`, `specRevisions` and `chainErrors` are as they were
  before the plan run, and no `notify` action is returned: nobody has
  anything to do. Given the `wait_for` action, then the driver posts on the
  issue one comment
  `The plan stage found this issue cannot be built yet: <reason>` (the
  reason through `neutraliseMarkers`), a blank line, then spec 066's
  `blockedByComment([37, 94])` (`Blocked until #37, #94 are done.` and the
  marker), and after the comment adds `blocked` and removes the claim label
  in one label call. The `release` action then removes the claim as today,
  and records `issue.released` with reason `blocked` for this release
  reason (no new value in `schemas/scheduler/event.json`). The label is
  set before the claim is removed, so no tick sees the issue unclaimed and
  unblocked. Given the comment or the label call fails, then the failure is
  the driver's as any failed action is (the claim stays, and the chain is
  retried or counted as a chain error as today); given the retry posts a
  second comment, the scan reads the latest marker and nothing is lost. A
  `chain.test.ts` test asserts the actions, the unchanged counts and the
  ledger; a `driver.test.ts` test asserts the comment's text, the label
  call, the removed claim and the event.
- AC-4. **A wait that names nothing to wait for, or a fourth wait, is a
  spec gap.** Given a `waiting` result whose `kept` is empty, then the
  machine handles it as a `spec_gap` (spec 006 AC-19: the spec stage
  answers the first; one after an answered gap is a bound hit) whose
  problem text is
  `the plan would wait (<reason>) but no named issue is open: ` followed by
  each dropped number with its cause (`#93 is done`, `#999 does not exist`,
  `#255 is this issue`, `#94 was abandoned and closed`). Given the ledger's `waits` is already `MAX_WAITS`,
  then the result is handled the same way with the problem text
  `the plan would wait a fourth time (<reason>, for #<a>, #<b>); the issue has waited 3 times: say in the spec what it needs or absorb it`.
  In both cases nothing is labelled and the claim stays. `MAX_WAITS` is
  exported from `machine.ts` beside `MAX_BLOCKS`; `boundsText` gains
  `, wait <n>/3` only when `waits` is above 0.
- AC-5. **The count survives the release and the wait is in the next plan's
  history.** Given the ledger (`schemas/scheduler/escalation-ledger.json`,
  `LedgerCounts`), then it gains the optional integer `waits` (minimum 0,
  written only once non-zero, as `designRevisions` is), seeded into a new
  chain by `seedFromLedger` and archived with the ledger at abandonment
  (spec 006 AC-7). Given the issue is claimed again after its block is
  lifted, then its chain starts at plan (the spec is on `main`; the gates
  are unchanged), `waits` is what the ledger held, and the plan's history
  holds the `plan: waiting for ...` entry. An answer not yet recorded
  (`pendingAnswer`) stays in the ledger across the wait, as across any
  release.

**Lifting**

- AC-6. **The scan's pass lifts a wait on any issue.** Given
  `liftFilerBlocks` (spec 066 AC-7, run by `fileDesignChildren` on the
  first tick after start and every move of `main`), then it judges every
  open issue carrying `blocked`, whoever its author is and whether or not
  its body carries the `panelator-child:` marker: the test
  `issue.author !== botLogin` goes, because the trust is in the marker
  comment's author, not the issue's, and the planned-child body test
  (`blocked.ts:63`) goes too, because the issue's comments say whose block
  it is. A block set for an `after:` carries the `panelator-child-blocked`
  marker and never a blocked-by one, so `latestBlockedBy` returns null for
  it and the pass leaves it to spec 031 AC-6; a wait carries the blocked-by
  marker and is the pass's, even on an issue the scan filed from a planned
  child (every issue of `docs/designs/product-v0-build.md`). Given open issue 255
  (authored by the maintainer or the bot) with `blocked` and the comment of
  AC-3 naming 37 and 94 as its latest blocked-by marker, when 37 and 94 are
  both done, then the pass removes `blocked`, posts
  `Unblocked: #37, #94 are done.` with the unblocked-by marker and logs
  `{ kind: "filer-unblocked", issue: 255, blocked_by: [37, 94] }`, exactly
  as for a filer block; given 94 is open, then nothing changes. Given 94 is closed with `abandoned`
  (the filer's re-triage decided `close`, or rewrote it after the block was
  set and the rewrite did not re-point this issue, as for an issue the bot
  did not author), then 94 will never be done: the pass removes `blocked`,
  posts `Unblocked: #94 was abandoned and closed; the plan will decide
  again.` with the unblocked-by marker for the numbers named, and logs
  `{ kind: "filer-unblocked", issue: 255, blocked_by: [37, 94] }`; the issue
  is claimed again, its chain starts at plan, and that plan names what it
  needs afresh (AC-3 drops 94 as `abandoned`; at most `MAX_WAITS` waits
  follow). A rewrite's re-point (spec 066 AC-6) that has replaced 94 in the
  marker before the scan makes the issue wait on the replacement instead. Given such a child-marked issue whose spec has merged
  (its design bullet is now a file bullet) or whose entry is still
  `planned`, with a wait comment of AC-3, then the pass lifts it when its
  predecessors are done; spec 031 AC-6's loop, which visits only entries
  still `planned` and stops at the `panelator-child-unblocked` comment, does
  not remove a wait, and spec 078 AC-1's repair (a bot-applied `blocked`
  with no `panelator-child-blocked` comment) skips an issue whose latest
  blocked-by marker is set, so it never posts a child-blocked comment over a
  wait. Everything else in spec 066 AC-7 holds: a number absent
  from the listing counts as done and is logged, a later unblocked-by
  marker by the bot ends the pass's interest in the issue, a
  `blocked_until` block is never lifted, and a failure on one issue is
  appended to `errors` and the pass goes on. The pass reads comments for
  open issues with `blocked` only (one `listComments` each per scan). A
  `children.test.ts` test with a maintainer-authored issue blocked by the
  bot's marker comment, its predecessors closing between two scans, asserts
  the lift, and a second with a body carrying `<!-- panelator-child: -->`
  (a waiting planned-child issue) asserts the lift and that no
  `panelator-child-blocked` comment is posted; a third, whose named
  predecessor is closed with `abandoned` (the others open), asserts the
  hand-back comment and the removed label, and a `driver.test.ts` test
  asserts that a plan naming a closed abandoned issue gets it in `dropped`
  with `why: "abandoned"` (and `kept` empty is a spec gap, AC-4). *(agent's call)* A predecessor that closes between the
  driver's listing in AC-3 and the label is lifted by the next scan (the
  next move of `main`, or the next start): a delay, never a strand.
- AC-7. **A hand-set block lifts itself when the maintainer's comment
  carries the marker.** Given `latestBlockedBy(comments, botLogin,
  maintainer)`, then a blocked-by marker counts when its comment's author is
  the bot or the maintainer, the latest such comment wins, and an
  unblocked-by marker counts only when the bot posted it. Given an open
  issue with `blocked` set by hand and a maintainer comment
  `Blocked until #93 merges. <!-- panelator-blocked-by:93 -->`, when 93 is
  done, then the pass lifts the label as in AC-6. Given the same comment by
  any other account, or a hand-set `blocked` with no marker comment, then
  the label is never removed (spec 031 AC-6, spec 066 AC-7).
  `fileDesignChildren` passes the maintainer login it is given through its
  dependencies (`cfg.maintainer`, already read by the loop for the
  shortlist's authority gate). A model cannot forge the maintainer's
  comment: stages comment as the bot, and model-written text is neutralised
  before the bot posts it (spec 076 AC-2). A `children.test.ts` test
  asserts the lift for the maintainer's comment and no lift for another
  account's.

**Unchanged**

- AC-8. **Nothing else about the plan, the shortlist or the filer changes.**
  Given a `ready` or `spec_gap` result, or an escalation, then the driver
  and the machine behave as on `main`, the profile check included. Given
  `selectEligible` with an issue carrying `blocked`, then it is skipped as
  today. Given a filer `rewrite` that supersedes an issue named by a
  bot-authored waiting issue's marker, then spec 066 AC-6 re-points it with
  no change to `apply.ts`, because the marker is the same. The existing
  chain, driver, children, filer and shortlist tests stay green.
- AC-9. **The earlier text is marked.** Spec 006 AC-19, spec 077 AC-2, spec
  066 AC-7, spec 031 AC-6 and spec 078 AC-1 carry the marks of section 4, and their earlier
  text follows unchanged.

## 4. Amendments to earlier specs

- Spec 006 AC-19 is marked `Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-3: a plan result of waiting that names an issue not yet done blocks the issue and releases the claim with no bound spent; one that names none, or a fourth, is handled as a spec_gap.`
- Spec 077 AC-2 is marked `Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-3: a plan result of waiting names no domain and skips the check, as an escalating plan does.`
- Spec 066 AC-7 is marked `Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-6: the pass judges every open blocked issue, whoever its author and planned child or not (a block for an `after:` has no blocked-by marker and is left to spec 031 AC-6), and a blocked-by marker comment by the maintainer counts as the bot's does (AC-7); a block naming an issue closed with `abandoned` is handed back, not kept for ever.`
- Spec 031 AC-6 is marked `Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-6 and AC-7: a wait on an issue carrying the child marker is lifted by the filer pass, not this loop, and a hand-set blocked whose comment by the maintainer carries a panelator-blocked-by marker is lifted once every issue it names is done; one without that marker is still never removed.`
- Spec 078 AC-1 is marked `Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-6: the repair skips an issue whose latest blocked-by marker is set, so it never posts a child-blocked comment over a wait.`

In each case the earlier text stays as the record. Spec 066 AC-3 and AC-6,
spec 060 and spec 026 AC-2 are not amended: the comment, the re-point, the
block on `main` and the `issue.released` reasons are used as they are.

## 5. Interfaces and files

This list is the implementation's file scope.

- `schemas/scheduler/plan-result.json`: the `waiting` variant (AC-1).
- `schemas/scheduler/stage-input.json`: `open_issues` (AC-2).
- `schemas/scheduler/escalation-ledger.json`: `waits` (AC-5).
- `agents/stages/plan.md`: the shape, the rule and `{{open_issues}}` (AC-2).
- `tools/scheduler/src/types.ts`: `PlanResult`'s `waiting` variant (AC-1).
- `tools/scheduler/src/stages/prompt.ts`: `StageInput.open_issues` and its
  value in `renderPrompt` (AC-2).
- `tools/scheduler/src/chain/types.ts`: `waits` on the plan's `stage_ok`
  event, `waits` on `ChainState`, the `wait_for` action (AC-3, AC-5).
- `tools/scheduler/src/chain/machine.ts`: `MAX_WAITS`, the `waiting` branch
  of `stageOk` case `plan`, `ledgerOf`, `seedFromLedger`, `boundsText`
  (AC-3 to AC-5).
- `tools/scheduler/src/chain/driver.ts`: the open-issue list in the plan's
  input; `stageEvent` case `plan` (no profile check for `waiting`, the
  listing, `kept` and `dropped`); the `wait_for` action; the `release`
  action's event reason (AC-2, AC-3).
- `tools/scheduler/src/filer/blocked.ts`: `liftFilerBlocks` without the
  author test, `latestBlockedBy` with the maintainer (AC-6, AC-7).
- `tools/scheduler/src/children/scan.ts`: spec 078 AC-1's repair skips an
  issue whose latest blocked-by marker is set (AC-6).
- `tools/scheduler/src/filer/blocked.ts` also: the hand-back of a block that
  names an issue closed with `abandoned` (AC-6).
- `tools/scheduler/src/children/scan.ts` and its caller in
  `tools/scheduler/src/service/loop.ts`: the maintainer login passed to the
  pass (AC-7).
- `tools/scheduler/src/filer/apply.ts`: only the call of `latestBlockedBy`,
  if its signature changes there (AC-7); no behaviour change.
- Specs 006, 031, 066, 077 and 078: the marks of section 4 (AC-9).
- Tests: `tools/scheduler/test/schema.test.ts` (AC-1), the plan-prompt test
  of spec 077 AC-4 and a prompt or driver test of the list (AC-2),
  `chain.test.ts` (AC-3 to AC-5), `driver.test.ts` (AC-3),
  `children.test.ts` (AC-6, AC-7).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). Nothing
here changes the sensitive-path list, the security criteria, what routes a
sensitive diff to the security review, section 3 of the design, or any text
marked as a maintainer answer. The App's permissions are unchanged: listing
issues, commenting and adding or removing a label use the issue permissions
the claim label and the children scan already need, and `blocked` exists as
a label on the repository. No new network listener, outbound host or shell
execution. The plan's prompt gains text from issue titles: only titles of
issues the bot or the maintainer wrote, neutralised and cut (AC-2), so an
outside account's issue never reaches the prompt. The new comment is a
public issue comment and carries issue numbers, the plan's one-sentence
reason (neutralised) and the scheduler's fixed phrases.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-3 chain test (a `waiting` plan releases with `planFailures` and
  `specAnswers` unchanged) and the AC-6 children test (the lift on a
  maintainer-authored issue) fail on `main` before the change and pass
  after it.
- A grep of `tools/scheduler/src` shows `panelator-blocked-by` written in
  `filer/blocked.ts` only.
- Live check after deploy: the next plan that returns `waiting` leaves its
  issue on GitHub with `blocked`, without `in-progress`, with the
  blocked-by comment under it; `log/service.jsonl` shows no failed plan for
  it and the next `tick` line with a non-empty `eligible` does not name it;
  when its predecessors close, the next children scan after a move of
  `main` logs `filer-unblocked` for it, and a later tick claims it and runs
  plan.

## 7. Open decisions

None.
