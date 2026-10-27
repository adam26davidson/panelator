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
  then re-plan, then spec revision, then a recorded abandonment.
- A new **spec** agent stage writes missing or incomplete specs, answers the
  plan's spec gaps, and revises specs. Its changes reach `main` through their
  own pull request.
- A new **question check** stage, an independent reviewer, decides whether a
  question really belongs to the maintainer before it is sent. Until spec A
  (Telegram) exists, questions are issue comments, and the maintainer's reply
  comment resumes the work.
- Security findings go through the fix loop instead of blocking.
- The automation-change gate is removed. `docs/charter.md` becomes a sensitive
  path, and the security review rejects any change to it.
- The design hierarchy (design section 10) gets a `Parent:` line on every spec,
  a `Children` list on every design, and checks for both.
- The documents that describe the old gates are updated.

## 2. Out of scope

- Telegram, session resume on reply, and question reply buttons (spec A).
  Here the resumed stage is a fresh session that gets the question and the
  answer as input.
- Producing UI design artifacts (spec E). Until E lands, a `web-ui` or `widget`
  issue without design artifacts is parked (AC-17). No human is asked.
- Standing agents, the findings filer, the action log (spec C). Abandonment
  appends a finding to the existing queue (spec 001 AC-28); nothing consumes
  it yet.
- Metrics (spec D). The records this spec writes are the raw events D will
  read.
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

  when the event is processed, then the chain runs a **rescue**. The stuck
  stage (a fix stage when the fix loop is exhausted) runs once more on the
  rescue model from chain configuration, in a fresh session. Its input is the
  history: every earlier attempt's result, failure reason, scope violations
  and review findings. No `needs-human` label is applied.
- AC-2. **A second bound triggers a re-plan.** Given a rescue has run on the
  issue, when a bound from AC-1 is hit again, then:
  - the PR is closed with a comment saying why;
  - its branch's commits are saved as a patch (as in spec 005);
  - the worktree is reset to `origin/main`;
  - the stage counters (fixes, failures, scope violations) reset to zero;
  - plan runs again, with the history as input.
- AC-3. **A third bound triggers a spec revision.** Given a re-plan has run,
  when a bound from AC-1 is hit again, then the spec stage runs in `revise`
  mode with the history as input.
- AC-4. **A revised spec is merged, then the issue is planned again.** Given
  the spec stage returns `revised` with a PR, then that PR goes through
  verify, review with the `spec` profile, and merge. It has its own fix
  counter, bounded like the issue's fix loop. After the merge, the chain
  continues at plan with fresh stage counters, reading the spec from
  `origin/main`.
- AC-5. **After a revision, the next bound ends in abandonment.** Given a spec
  revision has merged for the issue, when a bound from AC-1 is hit again,
  then:
  - the issue's PR is closed and its branch saved as a patch;
  - the issue is closed with the `abandoned` label and a comment linking the
    run records;
  - one finding naming the issue and the bounds hit is appended to the
    findings queue;
  - one notification is sent.

  The same applies when a spec PR's own fix loop is exhausted.
- AC-6. **The escalation bounds are fixed in code.** The bounds are named
  constants of the chain module beside `MAX_FIXES`: one rescue, one re-plan
  and one spec revision per issue. A test asserts their values. No stage
  definition or prompt can change them.

**Review escalation and security** (replaces AC-11)

- AC-7. **An escalation must say why.** Given a review result with verdict
  `escalate`, then it validates only if it carries an `escalation` object:
  - `kind`: `product`, `technical`, `capability` or `other`;
  - `question`;
  - `options`: each with a label and a cost;
  - `recommendation`.

  Given kind `other`, the chain runs a rescue of the fix stage, with the
  escalation as input (and the path continues as in AC-2 to AC-5). Given any
  other kind, the question goes to the question check (AC-11).
- AC-8. **Security findings go to the fix loop.** Given a diff touching a
  sensitive path, when review runs with the `security` profile and returns
  findings, then:
  - a fix stage runs with those findings as input;
  - after verify, a fresh review runs again with the `security` profile;
  - an approval with no findings merges.

  No `security-review` or `needs-human` label is applied. `merge_blocked` and
  the `securityFinding` hold on merge are removed.
- AC-9. **Charter edits are rejected.** Given a diff touching
  `docs/charter.md`, then:
  - it is sensitive, because `agents/sensitive-paths.txt` lists it;
  - the security profile's review criteria include a rule that any change to
    `docs/charter.md` is a finding;
  - the fix stage's input from that finding says to revert the change.

  A test asserts that both files contain these entries.
- AC-10. **The automation-change gate is gone.** Given a bot-authored issue with
  `validated` set by the App, whose spec lists `tools/scheduler/` or
  `agents/`, when shortlisted, then it is eligible. The automation-change gate
  and its tests are removed.

**Questions for the maintainer**

- AC-11. **Every question is checked first.** Given a stage produces a question
  (review escalation, the spec stage's `question` verdict), then the question
  check stage runs first, in a fresh session, with:
  - the question;
  - the design's section 3 rules;
  - the spec;
  - the history.

  It returns `send` or `decide_yourself`, with reasoning.
- AC-12. **A sent question pauses the issue.** Given `send`, then:
  - one issue comment headed "Question for the maintainer" is posted, carrying
    the options, the cost of each and the recommendation;
  - the issue receives `needs-decision`;
  - one notification is sent;
  - the claim is released;
  - the chain state, the asking stage and the question are written to
    `paused/<issue>.json` in the state directory;
  - no stage of the issue runs until it is answered.
- AC-13. **Anything else is sent back to decide.** Given `decide_yourself`, then
  the stage that asked runs again with the check's reasoning as input, and
  must decide. A spec stage in `decide` mode must return `revised`; any other
  verdict counts as a failed run. A review asked to decide must return
  `approve` or `changes_requested`. A second question from the same stage on
  the same issue goes to the check again. A second `decide_yourself` counts as
  a bound hit on the escalation path (AC-1 to AC-5).
- AC-14. **The maintainer's reply resumes the issue.** Given an issue labelled
  `needs-decision` with a `paused/` record, when a poll finds a comment
  written by the maintainer after the question comment, then:
  - `needs-decision` is removed;
  - the issue ranks ahead of everything else, including priority labels;
  - when claimed, the chain resumes from the saved state;
  - the asking stage runs in a fresh session with the question and the reply
    as input.

  A comment from anyone else does nothing.
- AC-15. **One reminder, no timeout.** Given a question unanswered for 24 hours,
  then one reminder notification is sent. No second reminder is sent. The
  issue is never abandoned or released for lack of an answer.

**Spec stage** (replaces AC-7, AC-8 routing and AC-9)

- AC-16. **Missing specs and spec gaps go to the spec stage.** Given a
  bot-authored, validated issue whose spec is missing or incomplete (any
  spec-present failure, including the parent checks of AC-19), when
  shortlisted, then it is eligible and its chain starts at the spec stage in
  `write` mode, not at plan. No `needs-spec` label is applied. Given a plan
  result of `spec_gap`, then the spec stage runs in `answer` mode with the
  questions; no `needs-clarification` label is applied. In both cases the
  spec PR follows AC-4, then plan runs.
- AC-17. **UI issues without designs wait for spec E.** Given a `web-ui` or
  `widget` spec without its design artifacts, when shortlisted, then the issue
  receives `needs-design-stage` with a comment that spec E will provide the
  design stage. It is not claimed. The label is applied once, with no repeat
  notification on later polls.
- AC-18. **The spec stage's contract.** Its result validates against
  `spec-result`:
  - `verdict`: `revised` or `question`;
  - `pr_number` and `head_sha`, required for `revised`;
  - `question`, required for `question`, in the shape of AC-7's escalation;
  - optional `findings`.

  Its PR is from branch `spec-<issue>` into `main`. The scope gate holds that
  PR to:
  - the spec's directory;
  - `docs/designs/`;
  - the `Children` section of the spec's parent design file.

  Review of a spec PR uses the `spec` profile. Its criteria: the spec fits its
  parent design and the issue body; it has the spec field set; it does not
  decide a section 3 question itself.

**Design hierarchy** (design section 10)

- AC-19. **Specs must link to their parent, and the parent back.** Given a spec
  without a `Parent:` line, or whose parent file does not exist on `main`, or
  whose parent's `## Children` section does not list the spec's path, then
  spec-present fails with the reason, and routes as AC-16.
- AC-20. **The design tree is checked in `pnpm test`.** A design-tree check in
  `tools/scheduler` reads the repository's designs and specs and fails on:
  - a dangling `Parent:` or `Children` link;
  - a child that does not name its parent back;
  - a cycle;
  - a sub-design in `docs/designs/` with fewer than two children.

  The two top designs and the charter are exempt from the two-children rule;
  the charter has no `Children` section. The check runs as a vitest test over
  the real repository.
- AC-21. **The existing specs join the tree.**
  - Specs 001 to 006 carry `Parent: docs/delivery-system-design.md`.
  - That document has a `## Children` section listing them.
  - `docs/product-spec.md` has an empty `## Children` section.
  - Both top designs carry `Parent: docs/charter.md`.
  - The check in AC-20 passes on the repository.

**Independent reviewers** (design section 6.3)

- AC-22. **Strong-tier fallback for independent stages.** A stage definition may
  set `independent: true`, which lets a strong-tier stage name a `fallback`
  (an exception to spec 001 AC-25). The question check stage is defined
  `harness: pi` with an OpenAI model, `independent: true`, and a Claude
  `fallback`. Given its primary run fails with a quota or rate-limit error,
  then it is retried once on the fallback in a fresh session. The usage
  record names the model that produced the result.

**No human stop is left**

- AC-23. **No path ends in `needs-human`.** The `NEEDS_HUMAN` constant and the
  `needs-human` chain stage no longer exist. The chain module has a
  table-driven test over every transition, and no event leads to a state that
  waits on a human other than `paused` (AC-12). The ended states are `done`,
  `abandoned` and `paused`.
- AC-24. **End-to-end chains are recorded.** Recorded end-to-end tests (fake
  adapter, mocked GitHub) drive these chains to their end and assert the label
  and comment sequence:
  - rescue then merge;
  - re-plan then merge;
  - spec revision then merge;
  - a question paused, answered and merged;
  - a `decide_yourself` then merge;
  - an abandonment;
  - a security finding fixed then merged.

## 4. Chain changes

The spec 001 section 5 table, as amended. Rows not listed are unchanged.

| From | Event | To |
|---|---|---|
| claimed | start, spec ok | plan |
| claimed | start, spec missing or incomplete | spec (`write`) |
| plan | `spec_gap` | spec (`answer`) |
| plan, implement, review | failed, retry used | escalate |
| implement, fix | scope violation, second time | escalate |
| fix | failed | escalate |
| review | `changes_requested`, fixes = 2 | escalate |
| review | `escalate`, kind `other` | escalate (escalation as input) |
| review | `escalate`, other kinds | question check |
| review | findings with the security profile | fix (findings as input) |
| review | `approve` | merge (no security hold) |
| spec | `revised` | verify, review (`spec` profile), merge on the spec PR, then plan |
| spec | `question` | question check |
| spec | failed, retry used | escalate |
| question check | `send` | paused |
| question check | `decide_yourself` | the asking stage, decide mode |
| paused | maintainer reply | the asking stage, with the answer |
| escalate | no rescue used | rescue of the stuck stage |
| escalate | rescue used, no re-plan used | re-plan |
| escalate | re-plan used, no spec revision used | spec (`revise`) |
| escalate | spec revision used | abandoned |

`escalate` is not a resting state: it is the transition rule the table names,
applied immediately.

## 5. Interfaces and files

- `tools/scheduler/src/chain/`:
  - `types.ts`: new stages `spec`, `question-check`, `paused`, `abandoned`;
    `needs-human` removed; escalation counters and the spec PR in
    `ChainState`.
  - `machine.ts`: the section 4 rows and the AC-6 constants.
  - `driver.ts`: rescue model selection, PR close, the spec PR sub-chain,
    pause and resume.
- `tools/scheduler/src/gates/`:
  - `automation-change.ts` and its tests removed;
  - `fix-loop.ts` no longer returns a label;
  - `spec-present.ts` gains the parent checks;
  - `ui-design.ts` returns `needs-design-stage`;
  - `ready.ts` routes to the spec stage;
  - a new `design-tree.ts` for AC-20.
- `tools/scheduler/src/spec/parse.ts`: the `Parent:` line and the `## Children`
  section.
- `tools/scheduler/src/shortlist/select.ts`: AC-10 and AC-16 eligibility;
  resume priority for answered paused issues (AC-14).
- `tools/scheduler/src/github/client.ts`: list an issue's comments with author
  and time; close an issue; close a pull request.
- `tools/scheduler/src/state/`: `paused/<issue>.json`, and abandonment records.
- `tools/scheduler/src/stages/definition.ts` and `src/types.ts`: stage names
  `spec` and `question-check`; `independent`; spec modes `write`, `answer`,
  `revise` and `decide` passed in the stage input.
- `agents/stages/spec.md` (strong tier, Claude) and
  `agents/stages/question-check.md` (strong tier, pi with an OpenAI model,
  `independent: true`, Claude fallback).
- `agents/profiles/spec/`: `profile.yaml`, `instructions.md`,
  `review-criteria.md` (AC-18).
- `agents/profiles/security/review-criteria.md`: the charter rule (AC-9);
  `instructions.md`: "any finding blocks merge until the maintainer looks"
  replaced by "findings go to the fix loop".
- `agents/sensitive-paths.txt`: add the charter's path (this spec does not list the charter itself, so the scope gate keeps it out of the diff).
- `agents/scheduler.yaml`: `rescue_model`.
- `schemas/scheduler/`:
  - `spec-result.json`;
  - `question-check-result.json`;
  - `paused.json`;
  - `review-result.json` gains `escalation`;
  - `stage-input.json` gains `history`, `question`, `answer`, `mode`;
  - `claim.json` follows `ChainState`.
- `specs/001-*` to `specs/005-*`: `Parent:` line. Spec 001's status line gains
  "amended by spec 006". Its section 2 spec numbers for the shortlist,
  Telegram and filing agent are corrected to name design specs A and C.
- `docs/delivery-system-design.md`:
  - `Parent:` line and `## Children` section;
  - the section 11 table moves the classification check from A to B.
- `docs/product-spec.md`: `Parent:` line and empty `## Children` section.
- `docs/process-spec.md`:
  - section 2: where the maintainer sits;
  - section 3: the spec row;
  - section 5: the automation rule, sensitive-path blocking, firmware stable
    as design section 5 states;
  - a link to the charter at the top.
- `specs/README.md`: no maintainer approval; the `Parent:` line; the hierarchy
  rules.

## 6. Verification

- `pnpm test` passes, including:
  - the chain transition table test (AC-23);
  - the escalation constants (AC-6);
  - the gates (AC-10, AC-16, AC-17, AC-19);
  - the design-tree check over the real repository (AC-20, AC-21);
  - the AC-9 file assertions;
  - the AC-22 fallback against recorded pi and Claude streams;
  - the recorded end-to-end chains of AC-24.
- After the service is restarted on the merged code, the first real issue
  that reaches any escalation step is written up in `dev-logs/` with its run
  records.

## 7. Open decisions

None.
