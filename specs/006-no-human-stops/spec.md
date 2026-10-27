# 006. The chain runs to merge with no human stops

Status: written 2026-10-27 from the delivery-system design; specs derived from
that design need no maintainer approval (design section 11). Built by hand in a
supervised session, because under the gates it replaces it would stop for the
maintainer.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 3, 4, 5, 6.3, 10 and 11 (spec B);
[charter](../../docs/charter.md); amends
[001-scheduler-core](../001-scheduler-core/spec.md) sections 3, 5, 6, 8 and 10.

## 1. Goal

Remove every place where the scheduler stops for the maintainer, other than
the questions the design keeps for the maintainer (design section 3).
Specifically:

- Every `needs-human` outcome becomes an escalation path run by agents: rescue,
  then re-plan, then spec revision, then a recorded abandonment. The counts
  are kept per issue and survive a release.
- A new **spec** agent stage writes missing or incomplete specs, answers the
  plan's spec gaps, revises specs, and records the maintainer's answers. Its
  changes reach `main` through their own pull request, whose diff is gated
  like any other.
- A new **question check** stage, an independent reviewer, decides whether a
  question really belongs to the maintainer before it is sent. Any agent stage
  can raise a question, including "I cannot do this" (design section 3, item
  3). Until spec A (Telegram) exists, questions are issue comments that
  @-mention the maintainer, and the maintainer's reply comment resumes the
  work. Every question and answer is logged, and every answer is written into
  the spec or an ADR before the work continues.
- Security findings go through the fix loop instead of blocking.
- The automation-change gate is removed. `docs/charter.md` becomes a sensitive
  path, and the security review rejects any change to it. The two top designs
  become sensitive paths too, so the maintainer's recorded decisions in them
  are protected (design section 5).
- The design hierarchy (design section 10) gets a `Parent:` line on every spec,
  a `Children` list on every design, and checks for both.
- The documents that describe the old gates are updated.

## 2. Out of scope

- Telegram, session resume on reply, and question reply buttons (spec A).
  Here the resumed stage is a fresh session that gets the question and the
  answer as input.
- Producing UI design artifacts (spec E). Until E lands, a `web-ui` or `widget`
  issue without design artifacts is parked (AC-20). No human is asked. Spec E
  re-evaluates every issue labelled `needs-design-stage` and removes the label
  once it can run the design stage; this spec only applies it.
- Standing agents, the findings filer, the action log (spec C). Abandonment
  appends a finding to the existing queue (spec 001 AC-28); nothing consumes
  it yet.
- Metrics (spec D). The records this spec writes (the escalation ledger, the
  questions log) are the raw events D will read.
- Narrowing what counts as a product decision (design section 3, item 1).
  That is the maintainer's call; the question check applies section 3 as
  written.
- Intake and grilling. The authority and validated gates are unchanged.
- Firmware release (spec G).

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
Each criterion names the spec 001 criterion it replaces where there is one.

**Escalation path** (replaces the `needs-human` rows of spec 001 section 5,
AC-10 second sentence, AC-13)

- AC-1. **First bound triggers a rescue.** Given any of these:
  - plan has failed twice;
  - implement has failed twice;
  - review has failed twice;
  - a fix run has failed;
  - scope was violated twice;
  - the fix loop has reached its bound;
  - the question check has failed twice (the stuck stage is the one that
    asked);
  - plan returned `spec_gap` after its spec gap had already been answered
    (AC-19; the stuck stage is plan);
  - the question check returned `decide_yourself` a second time (AC-14);

  when the event is processed, then the chain runs a **rescue**. The stuck
  stage (a fix stage when the fix loop is exhausted) runs once more on the
  rescue model from chain configuration, in a fresh session. Its input is the
  history (AC-7). No `needs-human` label is applied. A bound hit by the spec
  stage or on a spec PR follows AC-5's spec-track rule instead.
- AC-2. **A second bound triggers a re-plan.** Given a rescue has run on the
  issue, when a bound from AC-1 is hit again, then:
  - the PR is closed with a comment saying why, and its branch is deleted on
    GitHub;
  - its branch's commits are saved as a patch (as in spec 005);
  - the worktree is put on a fresh `issue-<issue>` branch from `origin/main`;
  - the stage counters (fixes, failures, scope violations) reset to zero;
  - plan runs again, with the history as input.
- AC-3. **A third bound triggers a spec revision.** Given a re-plan has run,
  when a bound from AC-1 is hit again, then the spec stage runs in `revise`
  mode with the history as input.
- AC-4. **A revised spec is merged, then the issue is planned again.** Given
  the spec stage returns `revised` with a PR, then that PR goes through the
  scope check of AC-22, verify, review and merge. Review uses the `spec`
  profile, or the `security` profile when the diff touches a sensitive path.
  The PR has its own fix counter, bounded like the issue's fix loop. After the
  merge:
  - `spec-<issue>` is deleted in the worktree and on GitHub;
  - the merge is not recorded in the shortlist's feature-to-debt merge record;
  - the chain continues at plan with fresh stage counters, reading the spec
    from `origin/main`.
- AC-5. **After a revision, the next bound ends in abandonment.** Given a spec
  revision has merged for the issue, when a bound from AC-1 is hit again,
  then:
  - the issue's PR is closed, its branch saved as a patch and deleted;
  - the issue receives the `abandoned` label before `in-progress` is removed,
    and a comment that @-mentions the maintainer and links the run records;
  - the issue stays open; the shortlist skips any issue labelled `abandoned`;
  - one finding naming the issue and the bounds hit (from the ledger of AC-7)
    is appended to the findings queue;
  - one notification is sent.

  **Spec track.** A bound hit by the spec stage itself, or on a spec PR (its
  fix loop, its scope, its review), runs one rescue of the stuck stage if the
  issue's spec-track rescue is unused; otherwise the issue is abandoned as
  above. Re-plan and spec revision do not apply on the spec track.
- AC-6. **The escalation bounds are fixed in code.** The bounds are named
  constants of the chain module (`MAX_FIXES` stays in the fix-loop gate):
  - one rescue on the issue track and one on the spec track;
  - one re-plan;
  - one spec revision;
  - one answered spec gap (`MAX_SPEC_ANSWERS`); a `spec_gap` after it is a
    bound hit;
  - one `decide_yourself` return;
  - six hours of pending required checks (`VERIFY_PENDING_MAX_H`, AC-17).

  All are counted per issue. A test asserts their values. No stage definition
  or prompt can change them.
- AC-7. **Escalation state is per issue and survives a release.** Given an
  issue whose chain has used any escalation bound and was then released (for
  example by liveness) and claimed again, then the new chain starts with the
  same counters and history. They are kept in `escalations/<issue>.json` in
  the state directory, written whenever a counter or the history changes, and
  read when the issue is claimed and when it is abandoned. At abandonment the
  ledger is archived, so an issue the maintainer later unlabels starts with
  fresh counts. The history gains
  an entry on every failed run, scope violation, `changes_requested` and check
  failure, not only when a bound is hit. Each entry is capped in length, and
  the last 20 are kept. Given a claim file written before this spec (with
  `securityFinding` and without the new fields), when it is read, then it
  loads with defaults and its chain continues.

**Review escalation and security** (replaces AC-11)

- AC-8. **An escalation must say why.** Given a review result with verdict
  `escalate`, then it validates only if it carries an `escalation` object:
  - `kind`: `product`, `technical`, `capability` or `other`;
  - `question`;
  - `options`: each with a label and a cost;
  - `recommendation`.

  Given kind `other`, the chain treats it as a bound hit with the fix stage as
  the stuck stage and the escalation as input (a rescue fix, and the path
  continues as in AC-2 to AC-5). Given any other kind, the question goes to the
  question check (AC-12).
- AC-9. **Security findings go to the fix loop.** Given a diff touching a
  sensitive path, when review runs with the `security` profile and returns
  findings, then:
  - a fix stage runs with those findings as input;
  - after verify, a fresh review runs again with the `security` profile;
  - an approval with no findings merges.

  No `security-review` or `needs-human` label is applied. `merge_blocked` and
  the `securityFinding` hold on merge are removed.
- AC-10. **The charter and the maintainer's recorded decisions are
  protected.** Given a diff touching `docs/charter.md`, then:
  - it is sensitive, because `agents/sensitive-paths.txt` lists it;
  - the security profile's review criteria include a rule that any change to
    `docs/charter.md` is a finding;
  - the fix stage's input from that finding says to revert the change.

  Given a diff touching `docs/product-spec.md` or
  `docs/delivery-system-design.md`, then it is sensitive (both are listed),
  and the security criteria make any change to them a finding unless it only
  edits the file's `## Children` section or cites a recorded maintainer answer
  (the question comment and the maintainer's reply, or the ADR recording it).
  Given a diff that removes any of these three entries from
  `agents/sensitive-paths.txt`, or removes or weakens these rules in the
  security criteria, then that is a finding too. A test asserts that both
  files contain these entries.
- AC-11. **The automation-change gate is gone.** Given a bot-authored issue with
  `validated` set by the App, whose spec lists `tools/scheduler/` or
  `agents/`, when shortlisted, then it is eligible. The automation-change gate
  and its tests are removed.

**Questions for the maintainer**

- AC-12. **Every question is checked first.** Given a stage produces a question
  (a review escalation, the spec stage's `question` verdict, an escalation on a
  plan, implement or fix result, or the verify bound of AC-17), then the
  question check stage runs first, in a fresh session, with:
  - the question;
  - the design's section 3 rules;
  - the spec;
  - the history.

  It returns `send` or `decide_yourself`, with reasoning. Given the check
  fails, it is retried once (the fallback of AC-26 applies first); a second
  failure is a bound hit for the stage that asked (AC-1).
- AC-13. **A sent question pauses the issue.** Given `send`, then, in this
  order:
  - the chain state, the asking stage and the question are written to
    `paused/<issue>.json` in the state directory;
  - one issue comment headed "Question for the maintainer" is posted. It
    @-mentions the maintainer login from `agents/scheduler.yaml` and carries
    the options, the cost of each and the recommendation. Its comment id and
    GitHub's creation time are stored in the paused record;
  - the issue receives `needs-decision`, then loses `in-progress`;
  - one notification is sent;
  - the claim is released.

  No stage of the issue runs until it is answered, and the shortlist treats an
  issue with a paused record as claimed. A crash between any two steps is
  completed on the next tick from the record, without a second question
  comment.
- AC-14. **Anything else is sent back to decide.** Given `decide_yourself`, then
  the stage that asked runs again with the check's reasoning as input, and
  must decide:
  - a spec stage in `decide` mode must return `revised`;
  - a review must return `approve` or `changes_requested`;
  - a plan, implement or fix result must not carry an `escalation`.

  Any other result counts as a failed run. Given the asking stage is verify
  (AC-17), `decide_yourself` is a bound hit with the fix stage as the stuck
  stage and the reasoning as its input. A second question from the same stage
  on the same issue goes to the check again. A second `decide_yourself` on the
  issue is a bound hit on the escalation path (AC-1 to AC-5).
- AC-15. **The maintainer's reply resumes the issue.** Given an issue labelled
  `needs-decision` with a `paused/` record, when a poll finds a comment by the
  maintainer whose id is higher than the question comment's id and whose
  creation time is later, then, in this order:
  - a claim is written from the saved state;
  - the issue receives `in-progress`, then loses `needs-decision`;
  - the paused record is removed;
  - the chain resumes at the stage AC-18 names, in a fresh session with the
    question and the reply as input.

  The resumed issue takes the next free slot before any shortlisted issue,
  including priority-labelled ones. A comment from anyone else, or one older
  than the question, does nothing. A record whose issue already has a claim or
  a running chain is not resumed again. A paused issue the maintainer closes
  has its record dropped.
- AC-16. **One reminder, no timeout.** Given a question unanswered for 24
  hours, then one reminder is sent: an issue comment that @-mentions the
  maintainer, and one notification. No second reminder is sent. The issue is
  never abandoned or released for lack of an answer.
- AC-17. **Any stage can report what it cannot do.** Given a plan, implement or
  fix result that carries an `escalation` (kind `capability`, `product` or
  `technical`; `other` does not validate there), then the question goes to the
  question check (AC-12) with that stage as the asking stage. A result with an
  `escalation` need not carry the stage's other required fields, and the
  scheduler skips its PR and scope checks. Given a PR whose required checks
  have stayed pending for six hours since verify first saw them pending, then
  the chain raises a question of kind `capability` ("a required check never
  reported"), with verify as the asking stage, through the question check.
- AC-18. **Answers are recorded before the chain continues.** Given the
  maintainer's answer to a `product` or `technical` question:
  - asked by the spec stage: the spec stage resumes in its mode and writes the
    answer into the spec, or into an ADR under `docs/decisions/`, in its spec
    PR;
  - asked by plan or implement: the spec stage runs in `record` mode and
    writes it the same way; after that spec PR merges, plan runs;
  - asked by review or fix: the fix stage runs with the answer as input,
    records it as an ADR under `docs/decisions/` in the issue PR, and applies
    it; a fix result whose diff adds no file there is a failed run. Verify and
    a fresh review follow.

  Given an answer to a `capability` question, the asking stage runs again with
  the answer as input (verify starts its six-hour window again); it is not a
  decision, so nothing beyond the log is recorded. Every question is logged
  in `questions/log.jsonl` in the state directory, one line per event, each
  with the issue, the asking stage and a timestamp:
  - asked, with the question;
  - checked, with the verdict and reasoning;
  - sent, with the comment id;
  - reminded;
  - answered, with the answer.

**Spec stage** (replaces AC-7, AC-8 routing and AC-9)

- AC-19. **Missing specs and spec gaps go to the spec stage.** Given a
  bot-authored, validated issue whose spec is missing or incomplete (any
  spec-present failure, including the parent checks of AC-23), when
  shortlisted, then it is eligible and its chain starts at the spec stage in
  `write` mode, not at plan. No `needs-spec` label is applied. Given a plan
  result of `spec_gap`, then the spec stage runs in `answer` mode with the
  questions; no `needs-clarification` label is applied. Given a second
  `spec_gap` after an answered one, then it is a bound hit (AC-1). In each
  case the spec PR follows AC-4, then plan runs.
- AC-20. **UI issues without designs wait for spec E.** Given a `web-ui` or
  `widget` spec without its design artifacts, when shortlisted, then the issue
  receives `needs-design-stage` with a comment that spec E will provide the
  design stage. It is not claimed. The label is applied once, with no repeat
  notification on later polls. Spec E removes it (section 2).
- AC-21. **The spec stage's contract.** Its result validates against
  `spec-result`:
  - `verdict`: `revised` or `question`;
  - `spec_path`, `pr_number` and `head_sha`, required for `revised`;
  - `question`, required for `question`, in the shape of AC-8's escalation;
  - optional `findings`.

  **Branch.** The PR is from branch `spec-<issue>` into `main`. The scheduler
  creates that branch from `origin/main` and checks it out in the issue's
  worktree before the spec stage runs; the stage commits on it and pushes it,
  and does not create or switch branches. The PR body refers to the issue as
  `Refs #<issue>`; a spec PR whose body contains a closing keyword for any
  issue is a failed run.

  **Scope.** The scope check of AC-22 holds the spec PR to:
  - the spec's directory;
  - `docs/designs/`;
  - `docs/decisions/`;
  - the `Children` section of the spec's parent design file. The parent must
    be one of the two top designs or a file under `docs/designs/`; the charter
    is never an allowed parent.

  **Review.** Review of a spec PR uses the `spec` profile, unless the diff
  touches a sensitive path, when the `security` profile wins. The `spec`
  criteria: the spec fits its parent design and the issue body; it has the
  spec field set; it does not decide a section 3 question itself.
- AC-22. **The spec PR's own diff is gated.** Given a spec stage `revised`
  result, or a fix on a spec PR, then the scheduler checks the PR's diff
  against AC-21's scope. A violation is handled like implement's: one fix with
  the violations as input, then the spec-track rule of AC-5. Given a spec PR
  whose diff touches the charter, then it is never merged: a recorded
  end-to-end test drives a spec agent that keeps the edit to abandonment and
  asserts that no merge request was made.

**Design hierarchy** (design section 10)

- AC-23. **Specs must link to their parent, and the parent back.** Given a spec
  without a `Parent:` line, or whose parent file does not exist on `main`, or
  whose parent's `## Children` section does not list the spec's path, then
  spec-present fails with the reason, and routes as AC-19.
- AC-24. **The design tree is checked in `pnpm test`.** A design-tree check in
  `tools/scheduler` reads the repository's designs and specs and fails on:
  - a dangling `Parent:` or `Children` link;
  - a child that does not name its parent back;
  - a cycle;
  - a sub-design in `docs/designs/` with fewer than two children.

  The two top designs and the charter are exempt from the two-children rule;
  the charter has no `Children` section. The check runs as a vitest test over
  the real repository.
- AC-25. **The existing specs join the tree.**
  - Specs 001 to 006 carry `Parent: docs/delivery-system-design.md`.
  - That document has a `## Children` section listing them.
  - `docs/product-spec.md` has an empty `## Children` section.
  - Both top designs carry `Parent: docs/charter.md`.
  - The check in AC-24 passes on the repository.

**Independent reviewers** (design section 6.3)

- AC-26. **Strong-tier fallback for independent stages.** A stage definition may
  set `independent: true`, which lets a strong-tier stage name a `fallback`
  (an exception to spec 001 AC-25). The question check stage is defined
  `harness: pi` with an OpenAI model, `independent: true`, and a Claude
  `fallback`. Given its primary run fails with a quota or rate-limit error,
  then it is retried once on the fallback in a fresh session. The usage
  record names the model that produced the result.

**No human stop is left**

- AC-27. **No path ends in `needs-human`.** The `NEEDS_HUMAN` constant and the
  `needs-human` chain stage no longer exist. The chain module has a
  table-driven test that feeds every event shape to every chain stage:
  - every pair section 4 marks valid must not throw;
  - every other pair must throw the machine's invalid-event error, and any
    other exception fails the test;
  - no valid pair leads to a state that waits on a human other than `paused`
    (AC-13).

  The ended states are `done`, `released`, `abandoned` and `paused`.
- AC-28. **End-to-end chains are recorded.** Recorded end-to-end tests (fake
  adapter, mocked GitHub) drive these chains to their end and assert the label
  and comment sequence:
  - rescue then merge;
  - re-plan then merge;
  - spec revision then merge;
  - a question paused, answered, recorded and merged;
  - a `decide_yourself` then merge;
  - a capability question from implement, paused and answered, then merged;
  - an abandonment;
  - a security finding fixed then merged;
  - a spec PR that touches the charter, never merged (AC-22).

## 4. Chain changes

The spec 001 section 5 table, as amended. Rows not listed are unchanged.

| From | Event | To |
|---|---|---|
| claimed | start, spec ok | plan |
| claimed | start, spec missing or incomplete | spec (`write`) |
| plan | `spec_gap`, no gap answered yet | spec (`answer`) |
| plan | `spec_gap` after an answered gap | escalate (stuck: plan) |
| plan, implement, review, spec | failed, retry used | escalate |
| question check | failed, retry used | escalate (stuck: the asking stage) |
| any agent stage | failed, postponed for quota | waiting, then the same stage (spec keeps its mode) |
| implement, fix | scope violation, second time | escalate |
| fix | failed | escalate |
| review | `changes_requested`, fixes = 2 | escalate |
| plan, implement, fix | result with an `escalation` | question check |
| verify | checks pending for 6 hours | question check (kind `capability`, asking: verify) |
| review | `escalate`, kind `other` | escalate (stuck: fix, escalation as input) |
| review | `escalate`, other kinds | question check |
| review | findings with the security profile | fix (findings as input) |
| review | `approve` | merge (no security hold) |
| spec | `revised`, scope ok | spec track: verify, review (`spec` or `security` profile), merge |
| spec | `revised`, scope violated | spec track: fix with the violations; a second violation escalates |
| spec | `question` | question check |
| merge, spec track | merged | delete `spec-<issue>`; plan, fresh stage counters |
| question check | `send` | paused |
| question check | `decide_yourself`, first on the issue | the asking stage, decide mode (verify: escalate, stuck: fix) |
| question check | `decide_yourself`, second on the issue | escalate (stuck: the asking stage) |
| paused | reply to a spec question | spec, same mode, with the answer |
| paused | reply to a plan or implement product or technical question | spec (`record`) |
| paused | reply to a review or fix product or technical question | fix, recording an ADR |
| paused | reply to a capability question | the asking stage, with the answer |
| escalate | stuck spec or spec track, spec-track rescue unused | rescue of the stuck stage |
| escalate | stuck spec or spec track, spec-track rescue used | abandoned |
| escalate | issue track, no rescue used | rescue of the stuck stage |
| escalate | issue track, rescue used, no re-plan used | re-plan |
| escalate | issue track, re-plan used, no spec revision used | spec (`revise`) |
| escalate | issue track, spec revision used | abandoned |

`escalate` is not a resting state: it is the transition rule the table names,
applied immediately. A rescue run that fails escalates again at once, without
the usual retry.

**Valid events** (AC-27). An event is valid in a stage only as follows; every
other pair is invalid and throws:

- `start`: `claimed` and `waiting`;
- `stage_ok` and `stage_failed` (postponed or not) of a stage: only in that
  stage;
- `checks`: `verify`;
- `merge_result` and `head_moved`: `merge`;
- `rebase_conflict`: `plan`, `implement`, `review`, `fix`, `verify` and
  `merge` (the scheduler does not rebase for the spec stage or the question
  check);
- `answered`: `paused`;
- `liveness_expired`: every stage except `done`, `released`, `abandoned` and
  `paused`.

## 5. Interfaces and files

- `tools/scheduler/src/chain/`:
  - `types.ts`: new stages `spec`, `question-check`, `paused`, `abandoned`;
    `needs-human` removed; the escalation counters, the history, the track,
    the asking stage and the verify pending time in `ChainState`; the
    `close_pr`, `delete_branch`, `finding` and `pause` actions.
  - `machine.ts`: the section 4 rows, the AC-6 constants, and the
    normalization of a stored chain state (AC-7).
  - `driver.ts`: rescue model selection from the state, PR close, the spec PR
    sub-chain and its scope check, branch preparation, pause, the escalation
    ledger and the questions log.
- `tools/scheduler/src/gates/`:
  - `automation-change.ts` and its tests removed;
  - `fix-loop.ts` and `ready.ts` no longer return a label;
  - `spec-present.ts` gains the parent checks and routes to the spec stage;
  - `ui-design.ts` returns `needs-design-stage`;
  - a new `spec-scope.ts` for AC-21 and AC-22;
  - a new `design-tree.ts` for AC-24.
- `tools/scheduler/src/spec/parse.ts`: the `Parent:` line and the `## Children`
  section.
- `tools/scheduler/src/shortlist/select.ts`: AC-11 and AC-19 eligibility; the
  `abandoned` skip; paused issues counted as claimed.
- `tools/scheduler/src/service/loop.ts`: resume of answered paused issues
  ahead of the shortlist (AC-15), reminders (AC-16), spec-start claims, and
  claims seeded from the escalation ledger.
- `tools/scheduler/src/github/client.ts` and `github/types.ts`: list an issue's
  comments with id, author and time; `comment` returns the new comment's id
  and creation time; close a pull request; delete a branch; set an issue
  body; a pull request's body.
- `tools/scheduler/src/runner/worktree.ts`: check out a named branch from a
  base, and delete a local branch.
- `tools/scheduler/src/runner/retry.ts`: the independent fallback (AC-26).
- `tools/scheduler/src/config.ts`: `rescue_model`.
- `tools/scheduler/src/state/`: paused records, the escalation ledger, the
  questions log, and claim normalization on read.
- `tools/scheduler/src/stages/definition.ts`, `src/stages/prompt.ts` and
  `src/types.ts`: stage names `spec` and `question-check`; `independent`;
  spec modes `write`, `answer`, `revise`, `decide` and `record` passed in the
  stage input; the `escalation` field on plan, implement and fix results.
- `tools/scheduler/test/`: the tests named in section 6.
- `agents/stages/spec.md` (strong tier, Claude) and
  `agents/stages/question-check.md` (strong tier, pi with an OpenAI model,
  `independent: true`, Claude fallback).
- `agents/stages/plan.md`, `agents/stages/implement.md`,
  `agents/stages/fix.md` and `agents/stages/review.md`: the history, answer
  and decide inputs; the `escalation` object and when to use it; plan's spec
  questions go to the spec stage, not the maintainer.
- `agents/profiles/spec/`: `profile.yaml`, `instructions.md`,
  `review-criteria.md` (AC-21).
- `agents/profiles/security/review-criteria.md`: the rules of AC-10;
  `instructions.md`: "any finding blocks merge until the maintainer looks"
  replaced by "findings go to the fix loop".
- `agents/sensitive-paths.txt`: add the charter's path and the two top
  designs (this spec does not list the charter itself, so the scope gate keeps
  it out of the diff).
- `agents/scheduler.yaml`: `rescue_model`.
- `schemas/scheduler/`:
  - `question.json`;
  - `spec-result.json`;
  - `question-check-result.json`;
  - `paused.json`;
  - `escalation-ledger.json`;
  - `question-log-entry.json`;
  - `review-result.json`, `plan-result.json`, `implement-result.json` and
    `fix-result.json` gain `escalation`;
  - `stage-input.json` gains `history`, `question`, `answer`, `mode`,
    `decide_input`, `spec_problem`;
  - `claim.json` follows `ChainState`.
- `specs/001-*` to `specs/005-*`: `Parent:` line. Spec 001's status line gains
  "amended by spec 006". Its section 2 spec numbers for the shortlist,
  Telegram and filing agent are corrected to name design specs A and C.
- `docs/delivery-system-design.md`:
  - `Parent:` line and `## Children` section;
  - the section 11 table moves the classification check from A to B.
- `docs/product-spec.md`: `Parent:` line and empty `## Children` section.
- `docs/process-spec.md`:
  - a link to the charter at the top, and the charter in section 1's piece
    table;
  - section 2: rewritten to the charter's goal, with the maintainer reached
    only for design section 3 questions;
  - section 3: the spec row;
  - section 4.2 step 3: design flaws go through the design section 3 question
    check;
  - sections 4.5 and 7: marked superseded by the design (specs C and D);
  - section 5: the automation rule, sensitive-path blocking, and firmware
    stable promotion (none until spec G, then automatic under G).
- `specs/README.md`: no maintainer approval; the `Parent:` line; the hierarchy
  rules.

## 6. Verification

- `pnpm test` passes, and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the chain transition table test (AC-27);
  - the escalation constants (AC-6) and the ledger and claim normalization
    (AC-7);
  - the gates (AC-11, AC-19, AC-20, AC-21, AC-22, AC-23);
  - the design-tree check over the real repository (AC-24, AC-25);
  - the AC-10 file assertions;
  - the stage prompt files carry the new inputs (AC-1, AC-14, AC-17);
  - the AC-26 fallback against recorded pi and Claude streams;
  - the recorded end-to-end chains of AC-28.
- After the service is restarted on the merged code, the first real issue
  that reaches any escalation step is written up in `dev-logs/` with its run
  records.

## 7. Open decisions

None.
