# 063. A finding whose recurrence stops the pipeline is marked when filed and ranks ahead of ordinary work

Status: written 2026-11-14 from the delivery-system design for issue #123;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [charter](../../docs/charter.md) ("Bottlenecks to delivery
speed must be periodically sought out, identified and eliminated, so all the
data necessary for this task must be available");
[delivery-system design](../../docs/delivery-system-design.md) section 4
(agents resolve their own blockers), section 6.1 (the findings filer
produces issues; the infra health slot of process-spec 4.4), section 7 (queue
and shortlist wait time are recorded as raw events) and section 10 ("Small
work skips layers": a bug spec hangs directly off a top design);
[design-tree](../../docs/design-tree.md) R8.Q6 ("priority label wins, else
2:1 feature to debt, ratio measured": the maintainer's label stays first and
is not changed here); [process-spec](../../docs/process-spec.md) 4.2 (the
finding record and the filer's outcomes);
[001-scheduler-core](../001-scheduler-core/spec.md) section 7 (the shortlist's
eligibility rules, unchanged);
[008-agent-registry](../008-agent-registry/spec.md) AC-14 (the ranking,
amended as section 4 records), AC-16 (the filer decision's `issue` object,
amended) and AC-18 (the labels of a filed issue, amended);
[018-filer-class-labels](../018-filer-class-labels/spec.md) (how the class
label is resolved; the new label is not a class and goes through none of it);
[026-event-store](../026-event-store/spec.md) AC-2 (the `issue.eligible`
payload, amended);
[059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md) AC-4
(the "disk space blocks the chain" finding, amended to carry the mark) and
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-4 (the finding of a required check failing on `main`'s cause, amended the
same way);
[016-fair-slot-scheduling](../016-fair-slot-scheduling/spec.md) (how a slot is
granted; this spec changes only the order of the shortlist the grant reads).

## 1. Goal

A finding whose condition, when it recurs, stops every run or every PR is
marked as such from the moment it is written, and the issue it becomes
carries a label the shortlist ranks ahead of all ordinary work, right after
the maintainer's own `priority` label. The scheduler's own producers of such
findings (a full volume refusing every command, a required check failing on
`main`'s head) set the mark in code; the stages set it in their results; the
filer judges it independently and labels the issue, new or existing. The
maintainer's hand stays the other way to the front: `priority` wins as the
design-tree records, and the maintainer may set the new label too.

### What is wrong today (spec agent's reading of the records, 2026-11-14)

Issue #50 (the `/tmp/pair-*` inode leak) was filed by the maintainer on
2026-10-29 at 12:03Z with `validated` and `class:bug`, after the leak had
already failed one `pnpm test` run with `ENOSPC`. It described the mechanism
and the fix. It was never claimed; the same leak refused every Claude Code
run on 2026-11-01 and paused #39, #40 and #41. The service log
(`log/service.jsonl`, `tick` lines) shows why:

- The scheduler ticked until 2026-10-29T14:00Z and not again until
  2026-10-31T12:19Z. Nothing could be claimed for those 46 hours.
- With `slots: 1`, the shortlist is computed only when a claim fits under
  the held count (`Scheduler.tick`, `shortlist()` in
  `tools/scheduler/src/service/loop.ts`; spec 026 AC-2 records this). In
  the whole window it was computed twice: at 2026-10-31T12:19Z (18 eligible,
  claimed #62) and at 2026-10-31T23:08Z (24 eligible, claimed #38). Every
  other tick reported `eligible: 0, held: 1`.
- Both times the ranking of spec 008 AC-14 did what it says. #62 carried
  `priority`, set by the maintainer by hand at 12:53Z on 2026-10-29 (its
  label timeline), so it came first. #38 was created 2026-10-28T16:55Z,
  before #50; both are system work; oldest first chose #38.

So the shortlist never saw a reason to prefer #50: the only signal it ranks
by is the maintainer's `priority` label, and the maintainer had set it on
another pipeline-stopping issue (#62, the filer looping on its own failure)
but not on this one. Nothing an agent writes today can carry that signal.
The finding record (`schemas/scheduler/finding.json`) has `what`, `where`,
`evidence`, `noticed_how`, `suspected_cause` and `security`; the filer's
`file` decision has `issue: { title, body, class }` and the filed issue gets
exactly the class label and `validated` (spec 008 AC-18, `applyDecisions` in
`tools/scheduler/src/filer/apply.ts`). The two code paths that file findings
about the pipeline being stopped, spec 059 AC-4's "disk space blocks the
chain" and spec 060 AC-4's "required check `<name>` fails on a `<track>` PR
for a cause outside its scope", write ordinary records. The Chromium failure
on CI cache hits (issues #112 and #118) is the second case the issue names:
a required check failing for every PR, filed and queued like any bug.

### The fix

1. **The finding record can say the condition stops the pipeline.** An
   optional `stops_pipeline: true` on a finding means: when this condition
   recurs, every run or every PR stops (the harness refuses every command,
   a required check fails on `main`'s head for every PR, a standing agent or
   the scheduler fails on every tick). The two code producers above set it.
   Every stage prompt lists the field with that rule.
2. **The filer labels the issue.** Its decision's `issue` object gains
   `stops_pipeline`; a `file`, `escalate` or `rewrite` decision with it true
   creates the issue with the configured label as well, and a `merge_into`
   with it true adds the label to the open target. The filer decides the
   flag itself, from its own investigation, with the finding's flag as the
   claim it checks: the rule in its prompt is the one of item 1.
3. **The shortlist ranks the label second.** After the maintainer's
   `priority` label and before the preferred kind of work and age. The
   label's name is configured beside `priority` in `agents/scheduler.yaml`,
   default `stops-pipeline`. The `issue.eligible` event records whether an
   issue carried it, so the wait of such issues can be measured.

*(agent's call)* A second label rather than letting agents set `priority`.
Spec 001 section 7 and process-spec 4.5 call `priority` the maintainer's
label, and design-tree R8.Q6 is the maintainer's decision that it wins; an
agent-set label of its own keeps that decision untouched, keeps the two
signals tellable apart on the issue and in the events, and lets the
maintainer override either way (adding `priority` to something else, or
removing the agents' label). The maintainer's label stays first rather than
the blocker: that is the recorded decision, and changing it would be a
question for the maintainer, not this spec's call; in practice the
maintainer has used `priority` once, on a pipeline-stopper. The mark is set
by the producer and judged by the filer, not inferred by the shortlist from
the issue text, because the filer is where every finding is already
investigated independently (process-spec 4.2 step 2) and the shortlist is
code. A maintainer-filed issue such as #50 gets the label from the
maintainer's hand, as `priority` does today; the filer never sees it. No
preemption: a chain already running keeps its slot, and the label takes
effect the next time a claim fits under the held count, which is what "the
front of the shortlist" means in this scheduler (spec 026 AC-2). Cheap to
reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Preempting a running chain, or computing the shortlist while no slot is
  free. Spec 009 and spec 016 decide how slots are held and granted.
- A waiting or postponed claim holding the only slot for hours (spec 009's
  decision); the scheduler not running (a host matter).
- The maintainer's `priority` label, its rank and who sets it (design-tree
  R8.Q6): unchanged.
- Removing the label when a later finding or the filer judges the condition
  gone; the maintainer removes it by hand. An issue closes when its fix
  merges, as today.
- Labelling a maintainer-filed issue automatically, or re-triaging open
  issues the filer did not file.
- Infra health's findings for alarm kinds (spec 030 AC-15, spec 050): their
  text is unchanged; the filer judges them by the rule of AC-3 like any
  other record.
- The console's `up_next` (spec 051): it reads the ranked shortlist and so
  follows the new order with no change.
- The `priority` label on #62, the records of #50, and any backfill of
  events for the window described above.

## 3. Acceptance criteria

"Given" states use the fakes of the existing tests: `tools/scheduler/test/shortlist.test.ts`
(`issue(n, {labels})`, the `labels` config object), `tools/scheduler/test/filer.test.ts`
and `filer-results.test.ts` (temporary state directories, a mocked GitHub
client), `tools/scheduler/test/schema.test.ts`, `tools/scheduler/test/stages.test.ts`,
`tools/scheduler/test/chain.test.ts`, `tools/scheduler/test/transient.test.ts`
or `loop.test.ts` for spec 059's alarm, and `tools/scheduler/test/loop.test.ts`
for the eligible event. "The label" means the configured
`labels.stops_pipeline`, `stops-pipeline` unless the config says otherwise.

- AC-1. **The finding record carries the mark.** Given
  `schemas/scheduler/finding.json`, then it has an optional boolean
  `stops_pipeline` beside `security`, `additionalProperties` stays false, and
  the four required fields are unchanged. Given a result's `findings` entry
  with `stops_pipeline: true`, when `appendFindings` validates it, then it is
  queued with the field kept on the record; given `stops_pipeline: "yes"`,
  then the entry is rejected as a finding with any other wrong-typed field is
  today. `Finding` in `tools/scheduler/src/types.ts` gains
  `stops_pipeline?: boolean`. A schema test asserts the accept and the
  reject.
- AC-2. **Every stage prompt lists the field and its rule.** Given each of
  `agents/stages/plan.md`, `implement.md`, `fix.md`, `review.md`, `spec.md`,
  `design.md` and `question-check.md`, then its findings paragraph's example
  object shows `"stops_pipeline": false` after `"security": false`, lists
  `stops_pipeline` among the optional fields, and says, in these words or
  words that keep them: set `stops_pipeline` true only when the condition's
  recurrence stops every run or every PR (the harness refusing every
  command, a required check failing on `main`'s head for every PR, the
  scheduler or a standing agent failing on every tick); a condition that
  fails one issue's work is not one. `tools/scheduler/test/stages.test.ts`
  pins each file for `"stops_pipeline": false` and the phrase `stops every
  run or every PR`, and the full-input render of each committed prompt still
  succeeds.
- AC-3. **The filer judges and labels.** `schemas/scheduler/filer-result.json`:
  the decision's `issue` object gains an optional boolean `stops_pipeline`;
  `additionalProperties` stays false there. `agents/standing/findings-filer.md`
  says, under the outcomes: a record's `stops_pipeline` is the worker's
  claim; the filer sets `issue.stops_pipeline: true` on a `file`,
  `merge_into`, `escalate` or `rewrite` decision only when its own
  investigation shows that the condition's recurrence stops every run or
  every PR (the rule of AC-2, in the same words), whether or not the record
  claimed it, and leaves it off otherwise; and the input lists the label's
  name as `stops_pipeline_label`. Given `applyFilerResult` with a `file`,
  `escalate` or `rewrite` decision whose `issue.stops_pipeline` is true, then
  the issue is created with the class label, `validated` and the label
  (spec 008 AC-18 otherwise unchanged: marker, no `Spec:` line, the
  duplicate search); given one with it false or absent, then the labels are
  the class label and `validated` only. Given a `merge_into` an open
  bot-authored issue with `issue.stops_pipeline` true, then the comment of
  spec 008 AC-16 is added as today and the label is added to the target (an
  `addLabels` call, idempotent when the label is already there); given a
  `merge_into` whose target is closed or not bot-authored, then the fallback
  `file` creates the issue with the label as above. The filer input
  (`tools/scheduler/src/filer/input.ts`, `schemas/scheduler/filer-input.json`)
  gains `stops_pipeline_label: <the label>`. The triage row records
  `stops_pipeline: true` when the decision carried it. Filer tests cover the
  three label outcomes (created with, created without, added to a target);
  they fail on `main` before the change.
- AC-4. **The shortlist ranks the label right after `priority`.** Given
  `rankIssues` with eligible issues of which one carries `priority`, one the
  label, and others neither, then the order is: issues with `priority`
  (among them, the rest of the rule), then issues with the label, then the
  rest by the preferred kind of work and oldest first as spec 008 AC-14
  says. Given an issue with both labels, then it sorts with the `priority`
  issues. `Config.labels` gains `stops_pipeline: string`, read from
  `agents/scheduler.yaml` `labels.stops_pipeline`, default `stops-pipeline`
  when absent (a config test, as for `priority`), and `agents/scheduler.yaml`
  names it. The filer and the shortlist read the same configured name. A
  shortlist test with the four kinds of issue asserts the order and fails on
  `main` before the change.
- AC-5. **The wait is measurable.** Given the `issue.eligible` event of spec
  026 AC-2, then its payload gains `stops_pipeline: boolean` (true when the
  issue carries the label), `schemas/scheduler/event.json` requires it in
  that payload, and the loop test that asserts the payload (`loop.test.ts`,
  "records issue.eligible") asserts the field for an issue with and without
  the label. Earlier events in the store are not rewritten; the backfill path
  (spec 026 AC-4) skips the payload check as today.
- AC-6. **The scheduler's own pipeline-stopping findings carry the mark.**
  Given the `ENOSPC` alarm of spec 059 AC-4, then its "disk space blocks the
  chain" finding has `stops_pipeline: true`; the finding of a `network_outage`
  alarm of spec 015 AC-8 does not. Given the block of spec 060 AC-4, then its
  `finding` action's record has `stops_pipeline: true`. The existing tests of
  those two findings assert the field; no other code-side finding
  (`machine.ts` abandonment and chain-error findings, `loop.ts` chain-error
  findings, `standing/run.ts`, `actions/index.ts`, `children/scan.ts`) gains
  it.
- AC-7. **The earlier text is marked.** Spec 008 AC-14, AC-16 and AC-18, spec
  026 AC-2, spec 059 AC-4 and spec 060 AC-4 carry the marks of section 4, and
  their earlier text follows unchanged.

## 4. Amendments to earlier specs

- Spec 008 AC-14 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-4: after the maintainer's priority label and before the preferred kind, an issue carrying the configured stops-pipeline label ranks first.`
- Spec 008 AC-16 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-3: the decision's issue object may carry stops_pipeline.`
- Spec 008 AC-18 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-3: a decision with issue.stops_pipeline true also sets the configured stops-pipeline label, on the created issue or on the merge_into target.`
- Spec 026 AC-2 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-5: the issue.eligible payload gains stops_pipeline.`
- Spec 059 AC-4 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-6: the "disk space blocks the chain" finding carries stops_pipeline: true.`
- Spec 060 AC-4 is marked `Amended by [063-pipeline-stopping-finding-ranks-first](../063-pipeline-stopping-finding-ranks-first/spec.md) AC-6: the finding carries stops_pipeline: true.`

In each case the earlier text stays as the record. Spec 001 section 7 and
spec 016 are not amended: the eligibility rules and the slot grant apply as
written; only the order of the ranked list the grant reads changes. Spec
018 is not amended: the new label is not a class and is never resolved.

## 5. Interfaces and files

- `schemas/scheduler/finding.json`: optional `stops_pipeline` (AC-1).
- `tools/scheduler/src/types.ts`: `Finding.stops_pipeline?` (AC-1).
- `agents/stages/plan.md`, `implement.md`, `fix.md`, `review.md`, `spec.md`,
  `design.md`, `question-check.md`: the findings paragraph (AC-2).
- `agents/standing/findings-filer.md`: the rule and the input field (AC-3).
- `schemas/scheduler/filer-result.json`, `schemas/scheduler/filer-input.json`,
  `tools/scheduler/src/filer/input.ts` (`stops_pipeline_label`),
  `tools/scheduler/src/filer/apply.ts` (`Decision.issue.stops_pipeline`,
  the label on create and on `merge_into`, the triage row),
  `schemas/scheduler/triage-entry.json` if it lists properties closed (AC-3).
- `tools/scheduler/src/config.ts`: `labels.stops_pipeline`;
  `agents/scheduler.yaml`: `labels.stops_pipeline: stops-pipeline` (AC-4).
- `tools/scheduler/src/shortlist/rank.ts`: `rankIssues` (AC-4).
- `tools/scheduler/src/service/loop.ts`: `#recordEligible` payload;
  `schemas/scheduler/event.json` `issue.eligible` payload (AC-5).
- `tools/scheduler/src/service/loop.ts` (the `ENOSPC` alarm finding) and
  `tools/scheduler/src/chain/machine.ts` (the block's `finding` action)
  (AC-6).
- Specs 008, 026, 059 and 060: the marks of section 4 (AC-7).
- Tests: `tools/scheduler/test/schema.test.ts` (AC-1), `stages.test.ts`
  (AC-2), `filer.test.ts` or `filer-results.test.ts` (AC-3),
  `shortlist.test.ts` and `config.test.ts` (AC-4), `loop.test.ts` (AC-5),
  the tests that today assert the two findings (AC-6).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). Nothing
here changes the sensitive-path list, the security criteria, what routes a
sensitive diff to the security review, section 3 of the design, or any text
marked as a maintainer answer. The App's permissions are unchanged: adding
a label uses the issue-write permission the claim label already needs, and
GitHub creates a repository label that does not exist on first use through
the issues API; the implementation checks this on the live repository and
creates the label by hand if it does not. No new network listener, outbound
call or shell execution.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-3 filer tests and the AC-4 shortlist test fail on `main` before the
  change and pass after it.
- A grep of `agents/stages` shows `"stops_pipeline": false` in all seven
  stage prompts and of `tools/scheduler/src` shows `stops_pipeline: true`
  written in exactly two places: the `ENOSPC` alarm finding and the block's
  finding (AC-6).
- Live check after deploy: the next finding the filer files with
  `issue.stops_pipeline: true` appears on GitHub with the `stops-pipeline`
  label, and the next `tick` line of `log/service.jsonl` with a non-empty
  `claimed` while that issue is open and unclaimed names it, unless an issue
  with `priority` was eligible.

## 7. Open decisions

None.
