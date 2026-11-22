# 066. The findings filer can file an issue blocked on its predecessors, and the children scan lifts the block when they are done

Status: written 2026-11-15 from the delivery-system design for issue #126;
specs derived from that design need no maintainer approval (design section 11).
Amends [008-agent-registry](../008-agent-registry/spec.md) AC-16 (the filer
decision's `issue` object) and AC-18 (the labels of a filed issue), and
[031-design-files-children](../031-design-files-children/spec.md) AC-6 (what
the scan unblocks), marked as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (agents resolve their own blockers; "every other blocker is
resolved by agents"), section 6.1 (the findings filer produces issues) and
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design); [process-spec](../../docs/process-spec.md) 4.2 step 2 (the
filer's outcomes: an issue is "filed, validated, enters the shortlist");
[ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
("their issues are filed with the `blocked` label, which the shortlist skips,
and each loses it when its predecessor merges");
[001-scheduler-core](../001-scheduler-core/spec.md) section 7 (the
shortlist's eligibility rules, unchanged: `blocked` is skipped);
[008-agent-registry](../008-agent-registry/spec.md) AC-16 and AC-18
(amended as section 4 records);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) AC-6
(model-written text cannot carry the scheduler's own marker);
[018-filer-class-labels](../018-filer-class-labels/spec.md) (the class label
is resolved where it is applied; `blocked` is not a class);
[025-filer-results-and-wakes](../025-filer-results-and-wakes/spec.md) AC-1
(the prompt shows the exact shape of every decision);
[029-design-stage](../029-design-stage/spec.md) section 2 and section 4
(dependent specs ordered by `blocked` "as in the metrics and reflection
split");
[031-design-files-children](../031-design-files-children/spec.md) AC-5 and
AC-6 (the scan's `blocked` label, its marker comments, its done test and its
unblocking, which this spec reuses and extends);
[037-filer-apply-lists-open-issues-once](../037-filer-apply-lists-open-issues-once/spec.md)
(the batch's one listing of the bot's open issues, kept; the new listing of
all issues is made at most once per batch and only when a decision needs it);
[063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md)
AC-3 (the precedent: a field in the decision's `issue` object that becomes a
label on the filed issue).

## 1. Goal

The findings filer can record work that cannot be built yet: an issue filed
with the `blocked` label and a comment saying what it waits for, so the
shortlist leaves it alone instead of spending a spec run, a plan and
implement attempts on something whose predecessor has not merged. When the
predecessor is an issue, the children scan lifts the label by itself once
that issue is done, as it already does for a planned child's `after:`; when
no issue stands for the predecessor, the comment says the label is lifted by
hand. Nothing else about filing changes.

### What is wrong today (spec agent's reading, 2026-11-15)

- ADR 0004 and spec 029 order dependent specs with the `blocked` label and
  say each loses it when its predecessor merges. Both were applied by hand
  (#37, #94, #95 carry `blocked` with no marker comment). Spec 031 AC-5 and
  AC-6 made the children scan file a planned child blocked when an `after:`
  sibling is not done and lift the label when it is.
- The one agent that files issues from findings cannot do either. The
  filer's `file` decision carries `issue: { title, body, class,
  stops_pipeline }` and nothing about blocking
  (`schemas/scheduler/filer-result.json`, `Decision` in
  `tools/scheduler/src/filer/apply.ts`); `applyDecisions` creates every
  filed issue with exactly the class label, `validated` and, when set, the
  stops-pipeline label. The shortlist (`tools/scheduler/src/shortlist/select.ts`)
  skips `blocked`, so a filed issue is claimed on the next tick that has a
  free slot.
- So the filer had to discard what it could not file: findings refs 792 and
  813 asked for a blocked issue for the firmware side of design row G (the
  HIL workflow, serial harness, firmware build, signing and beta release of
  the row G spec work on issue #40's branch), which needs product milestone 1
  to put an ESP-IDF project under `firmware/` (today `firmware/` holds only
  `.gitkeep`). Both were discarded as premature, and the record of that work
  is gone from the tracker.

### The fix

1. **The decision can block the issue.** The filer decision's `issue` object
   gains `blocked_by` (one or more issue numbers the work waits for) or
   `blocked_until` (one sentence naming a condition no issue stands for), on
   `file` and `rewrite` decisions only. The filed issue gets `blocked` as a
   label and one comment saying what it waits for, carrying a marker that is
   the scheduler's record.
2. **The children scan lifts a `blocked_by` block.** On every scan (spec 031
   AC-3: the first tick after start and every move of `main`), every open
   bot-authored issue with `blocked` whose latest blocked-by marker comment
   names issues that are all done (closed and not `abandoned`, the done test
   of spec 031) loses the label and gets an unblocked comment. A
   `blocked_until` block, like a hand-set `blocked`, is never lifted by code.
3. **A rewrite re-points dependents.** When the filer's `rewrite` supersedes
   issue X with issue Y, every open bot-authored blocked issue whose latest
   marker names X gets a new blocked-by comment with Y in X's place, so the
   block follows the work instead of waiting on a closed number for ever.

*(agent's call)* The block is a field in the decision's `issue` object, as
`stops_pipeline` is (spec 063 AC-3), because it is a property of the filed
issue and becomes a label on it. Issue numbers are the automatic form because
the scheduler already has the done test and the unblocking pass for them
(spec 031 AC-6), and both are reused rather than written again: the scan's
one listing of all issues judges both kinds of block. The text form exists
because the live case has no predecessor issue (product milestone 1 is a
milestone, not an issue): without it the record is lost, which is what issue
#126 reports; with it the record waits with its condition written on it, and
a hand-set `blocked` is a path spec 031 AC-6 already recognises. The lift is
the scan's rather than the shortlist's because the shortlist runs only when a
slot is free and reads labels, not comments; the scan already lists all
issues and reads marker comments. The record is a comment with a marker, not
the issue body, because the body is written once (spec 008 AC-18's duplicate
search keys on it) and a re-point must leave the earlier record visible.
Cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Changing what the shortlist skips (`blocked`, `abandoned`, `in-progress`,
  `needs-*`: spec 001 section 7, `select.ts`) or how it ranks (spec 008
  AC-14, spec 063 AC-4).
- Lifting a `blocked_until` block by code, or re-triaging open blocked issues
  on the filer's schedule; the comment says a person lifts it.
- Lifting the block of an issue whose predecessor the filer closed as not
  worth doing (`close` of an abandoned issue): the predecessor stays
  `abandoned`, so the dependent's premise is gone and a person decides.
- Blocking on an `escalate` (the question must reach the spec stage) or a
  `merge_into` (the target's own block stands); blocking on a pull request
  rather than an issue (a discard resting on a PR is spec 025 AC-7).
- The hand-set blocks on #37, #94 and #95; the planned-child blocks of spec
  031 AC-5, whose markers and lifting are unchanged.
- Widening the filer's `open_issues` input beyond the bot's open issues
  (spec 037): the filer names predecessors from that list or from the
  record's own text; the scheduler checks them.
- Filing the firmware side of row G itself: that is the filer's decision on
  the next record that asks for it, made possible here.

## 3. Acceptance criteria

"Given" states use the fakes of the existing tests:
`tools/scheduler/test/filer.test.ts` and `filer-results.test.ts` (temporary
state directories, a mocked GitHub client), `tools/scheduler/test/children.test.ts`
(the scan's mocked `ChildrenGh` with `listIssues`, `comment`, `listComments`,
`removeLabel`) and `tools/scheduler/test/schema.test.ts`. "Done" means
closed and not labelled `abandoned` (spec 031 `isDone`). "The bot" is the App
bot login. Markers are the scheduler's: `<!-- panelator-blocked-by:<a>,<b> -->`
(issue numbers ascending, comma-separated, no spaces),
`<!-- panelator-unblocked-by:<a>,<b> -->` and `<!-- panelator-blocked-until -->`.
A "marker comment" is a comment posted by the bot whose body contains the
marker; a comment by any other account never counts.

**The decision**

- AC-1. **The schema allows the block on `file` and `rewrite` only.** Given
  `schemas/scheduler/filer-result.json`, then the decision's `issue` object
  gains two optional properties beside `stops_pipeline`: `blocked_by`, an
  array of integers at least 1, `minItems` 1 and `uniqueItems` true, and
  `blocked_until`, a string of `minLength` 1; `additionalProperties` stays
  false; `required` stays `title`, `body`, `class`. Given a decision whose
  `issue` carries both `blocked_by` and `blocked_until`, then the result is
  invalid. Given an `escalate` or `merge_into` decision whose `issue` carries
  either, then the result is invalid (an `if`/`then` on `outcome`, as the
  schema already does for `rests_on_pr`). Given a `file` decision with
  `blocked_by: [132]`, and another with `blocked_until: "an ESP-IDF project
  exists under firmware/"`, then both validate. `Decision.issue` in
  `tools/scheduler/src/filer/apply.ts` gains `blocked_by?: number[]` and
  `blocked_until?: string`, and `applyFilerResult`'s batch validation rejects
  a block on any outcome other than `file` or `rewrite` with an error, before
  any effect, as it rejects a wrong question kind today. A schema test
  asserts the two accepts and the three rejects.
- AC-2. **The prompt shows the shape and the rule.** Given
  `agents/standing/findings-filer.md`, then its example list has a `file`
  decision whose `issue` carries `"blocked_by":[132]` and a `rewrite` decision
  whose `issue` carries `"blocked_until":"..."` (one sentence), and under the
  outcomes it says, in these words or words that keep them: set
  `issue.blocked_by` on a `file` or `rewrite` decision when the work cannot
  be built before the issues it names are done (closed and not abandoned),
  naming only numbers from `input.open_issues` or quoted in the record's own
  text, never a guess; the scheduler files the issue with `blocked`, which
  the shortlist skips, and lifts the label when every named issue is done;
  use `issue.blocked_until` instead only when no issue stands for the
  predecessor, as one sentence saying what must be true (the label is then
  lifted by hand, so say it only for work a design or spec calls for); never
  on `escalate` or `merge_into`. The test that pins the prompt (spec 025
  AC-1, in `filer-results.test.ts`) also pins `"blocked_by":[` and
  `"blocked_until":` and the phrase `lifted by hand`.

**Filing**

- AC-3. **A `blocked_by` issue is filed blocked and says why.** Given
  `applyFilerResult` with a `file` decision whose `issue.blocked_by` is
  `[94, 132]` and both are open, then `applyDecisions` lists all issues once
  (`gh.listIssues({ state: "all", labelEvents: false })`; made at most once
  per batch, and not at all when no decision in the batch carries
  `blocked_by`; the bot's open-issue listing of spec 037 is unchanged),
  creates the issue through `createIssueRecorded` with labels the class
  label, `validated`, `blocked` and, when `stops_pipeline` is set, the
  stops-pipeline label (spec 008 AC-18 otherwise unchanged: marker, no
  `Spec:` line, the duplicate search), then posts one comment
  `Blocked until #94, #132 are done.` ending with
  `<!-- panelator-blocked-by:94,132 -->`, and the triage row carries
  `blocked_by: [94, 132]`. Given a `rewrite` decision with the same
  `issue`, then the new issue is filed the same way before the abandoned
  issue is closed as superseded. Given a number whose issue is done, then
  it is dropped from the block and the row's `reason` gains
  ` (blocked_by #<n> is done)`; given a number absent from the listing,
  then it is dropped, the row's `reason` gains ` (blocked_by #<n> does not
  exist)` and `{ kind: "filer-blocked-by-unknown", run_id, ref, issue: <n> }`
  is logged; given a number whose issue is closed with `abandoned`, then it
  stays in the block (its re-triage re-points it, AC-6). Given every number
  is dropped, then the issue is filed without `blocked` and without a
  comment, with the row's `reason` noting each drop. The comment and the
  marker carry only the numbers that remained, ascending.
- AC-4. **A `blocked_until` issue is filed blocked and lifted by hand.**
  Given a `file` or `rewrite` decision whose `issue.blocked_until` is
  `an ESP-IDF project exists under firmware/`, then the issue is created with
  `blocked` as in AC-3 (no listing of all issues is needed), one comment
  `Blocked until an ESP-IDF project exists under firmware/. Nothing lifts
  this label by itself: remove it by hand when the condition holds.` ending
  with `<!-- panelator-blocked-until -->` is posted, and the triage row
  carries `blocked_until` with the text. The children scan never removes
  this label (AC-7).
- AC-5. Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-2: the text is neutralised for every panelator- marker of any family, to a fixed point, not only the block prefixes. **The block survives a crash, and model text cannot forge it.**
  Given a `file` whose issue was created in an earlier batch (the duplicate
  search of spec 008 AC-18 finds it by its finding marker) and that issue
  carries `blocked` and has no bot comment with a `panelator-blocked-by` or
  `panelator-blocked-until` marker, when the decision carries `blocked_by`
  or `blocked_until`, then the comment of AC-3 or AC-4 is posted on it
  (one `listComments` call on that path only); given the comment is there,
  then nothing is posted. Given a decision whose `title`, `body`, `reason`
  or `blocked_until` text contains `<!-- panelator-blocked-by:1 -->`,
  `<!-- panelator-unblocked-by:1 -->` or `<!-- panelator-blocked-until -->`
  (any case, any spacing after `<!--`), then the text is neutralised as spec
  014 AC-6 neutralises the capability marker (`<!-- panelator-blocked` and
  `<!-- panelator-unblocked` become `<!-- `) before it reaches GitHub, so
  the only marker comments are the scheduler's own.
- AC-6. **A rewrite re-points the issues blocked on what it supersedes.**
  Given a `rewrite` decision for `issue:94` that files issue 150 and closes
  94 as superseded, and an open bot-authored issue 140 carrying `blocked`
  whose latest bot blocked-by marker comment is
  `<!-- panelator-blocked-by:94,132 -->`, then after the rewrite
  `applyDecisions` posts on 140 one comment `Blocked until #132, #150 are
  done (#94 was superseded by #150).` ending with
  `<!-- panelator-blocked-by:132,150 -->` and logs
  `{ kind: "filer-block-repointed", run_id, issue: 140, from: 94, to: 150 }`.
  Only issues in the batch's open-bot listing that carry `blocked` have
  their comments read (one `listComments` per such issue per rewrite);
  an issue whose latest marker does not name 94 is untouched; an issue with
  a `blocked_until` marker is untouched. Given a later `file` in the same
  batch whose `blocked_by` names 94, then the block is written with 150
  instead (the batch remembers its supersessions); given the `file` came
  earlier in the batch, then the rewrite's re-point covers it as above,
  because the batch's open list follows its own creates (spec 037 AC-7).

**Lifting**

- AC-7. Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-6: the pass judges every open blocked issue that is not a planned child, whoever its author, and a blocked-by marker comment by the maintainer counts as the bot's does (AC-7). **The children scan lifts a `blocked_by` block whose issues are
  done.** Given `fileDesignChildren` (spec 031 AC-3: the first tick after
  start and every move of `main`) and, in its listing, an open issue
  authored by the bot carrying `blocked` whose comments hold a bot comment
  with `<!-- panelator-blocked-by:94,132 -->` as the latest blocked-by
  marker and no later bot comment with a `panelator-unblocked-by` marker,
  when 94 and 132 are both done, then the scan removes `blocked`, posts one
  comment `Unblocked: #94, #132 are done.` ending with
  `<!-- panelator-unblocked-by:94,132 -->` and logs
  `{ kind: "filer-unblocked", issue, blocked_by: [94, 132] }`. Given 132 is
  still open, or closed with `abandoned`, then nothing changes. Given a
  number absent from the listing, then it counts as done and
  `{ kind: "filer-blocked-by-unknown", issue, blocked_by: <n> }` is logged.
  Given the latest blocked-by marker is followed by an unblocked-by marker
  comment by the bot, then the label is never touched again, however it was
  set since (as spec 031 AC-6 says for a child). Given an open bot-authored
  issue with `blocked` and only a `panelator-blocked-until` marker comment,
  or no marker comment at all (set by hand, as on #37), or a marker comment
  by any other account, then the scan never removes the label. Given the
  issue is a planned child of spec 031 AC-5 (a `panelator-child-blocked`
  marker), then spec 031 AC-6 applies as today and this pass does nothing
  to it. The pass runs after the planned children, over the same
  `listIssues` result, reading comments only for open bot-authored issues
  with `blocked` (one `listComments` each per scan); a failure on one issue
  is appended to the scan's `errors` and the pass goes on, as spec 031
  AC-6's does. A `children.test.ts` test with a blocked filer issue, its
  two predecessors closing between two scans, asserts the lift and the
  comment; a second asserts that a `blocked_until` issue and a hand-set
  `blocked` are untouched.

**The shortlist**

- AC-8. **Nothing about eligibility changes.** Given `selectEligible` with
  an issue carrying `blocked`, `validated` and a class label, then it is
  skipped with no decision recorded, as today (spec 001 section 7, spec 031
  AC-8); the existing shortlist test for `blocked` stays green. The
  `issue.filed` event (spec 026 AC-2) records the labels as given, so a
  blocked filing is visible in the event store with no schema change.

**Marks**

- AC-9. **The earlier text is marked.** Spec 008 AC-16 and AC-18 and spec 031
  AC-6 carry the marks of section 4, and their earlier text follows
  unchanged.

## 4. Amendments to earlier specs

- Spec 008 AC-16 is marked `Amended by [066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-1: on a file or rewrite decision the issue object may carry blocked_by (issue numbers) or blocked_until (one sentence).`
- Spec 008 AC-18 is marked `Amended by [066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-3: a decision whose issue carries blocked_by or blocked_until also sets blocked and posts a marker comment saying what the issue waits for.`
- Spec 031 AC-6 is marked `Amended by [066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-7: the scan also lifts a blocked set by the filer with a panelator-blocked-by marker comment once every issue it names is done; a hand-set blocked and a blocked_until block are still never removed.`

In each case the earlier text stays as the record. Spec 014 AC-6 and spec
037 are not amended: the capability marker's handling is the model for AC-5,
and the bot's open-issue listing stays one per batch; the listing of all
issues in AC-3 is a second, distinct call made only when needed. ADR 0004
and spec 029 are not amended: they describe the ordering this spec makes
possible for the filer.

## 5. Interfaces and files

This list is the implementation's file scope.

- `schemas/scheduler/filer-result.json`: `issue.blocked_by`,
  `issue.blocked_until`, the two `if`/`then` rules (AC-1).
- `agents/standing/findings-filer.md`: the examples and the rule (AC-2).
- `tools/scheduler/src/filer/blocked.ts` (new): the three markers, their
  parser (the numbers of a blocked-by marker), the neutraliser, the comment
  texts, the done test (imported from `children/markers.ts`), and
  `liftFilerBlocks({ gh, issues, botLogin, log })` returning
  `{ unblocked: number[]; errors: string[] }` (AC-5, AC-7).
- `tools/scheduler/src/filer/apply.ts`: `Decision.issue.blocked_by` and
  `blocked_until`; the batch validation; the one listing of all issues; the
  labels, the comment and the triage row in `file()`; the crash path; the
  re-point after `rewrite` and the batch's supersession map (AC-1, AC-3 to
  AC-6).
- `tools/scheduler/src/filer/input.ts`: `TriageEntry.blocked_by?` and
  `blocked_until?` (AC-3, AC-4); `schemas/scheduler/triage-entry.json` is
  open (`additionalProperties: true`) and needs no change.
- `tools/scheduler/src/children/scan.ts`: `fileDesignChildren` calls
  `liftFilerBlocks` with its listing after the planned children and merges
  its `unblocked` and `errors` into `ChildrenResult` (AC-7).
- Specs 008 and 031: the marks of section 4 (AC-9).
- Tests: `tools/scheduler/test/schema.test.ts` (AC-1),
  `filer-results.test.ts` (AC-2), `filer.test.ts` or `filer-results.test.ts`
  (AC-3 to AC-6), `children.test.ts` (AC-7).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). Nothing
here changes the sensitive-path list, the security criteria, what routes a
sensitive diff to the security review, section 3 of the design, or any text
marked as a maintainer answer. The App's permissions are unchanged: adding
and removing a label and commenting use the issue-write permission the claim
label and the children scan already need; `blocked` already exists as a
label on the repository. No new network listener, outbound call or shell
execution. The new comments are public issue comments and carry only issue
numbers, the filer's one-sentence condition (neutralised, AC-5) and the
scheduler's fixed phrases.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-3 filer test (filed with `blocked` and the comment) and the AC-7
  children test (the lift) fail on `main` before the change and pass after
  it.
- A grep of `tools/scheduler/src` shows `panelator-blocked-by` written in
  `filer/blocked.ts` only, and `createIssueRecorded` called from the same
  places as before (spec 026's one-caller rule, as amended by its own
  follow-ups).
- Live check after deploy: the next filer decision with `issue.blocked_by`
  appears on GitHub with `blocked`, `validated` and its class label, with
  the blocked-by comment under it, and the next `tick` line of
  `log/service.jsonl` with a non-empty `eligible` does not name it; when its
  predecessors close, the next children scan after a move of `main` logs
  `filer-unblocked` for it and the label is gone.

## 7. Open decisions

None.
