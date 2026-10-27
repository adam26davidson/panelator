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
  work; a reply that asks something back gets a follow-up question. Every
  question and answer is logged, and every answer is recorded before the work
  continues: a product answer in `docs/product-spec.md` or the top design it
  belongs to, a technical answer in the spec or an ADR, each marked with the
  question it answers.
- Security findings go through the fix loop instead of blocking.
- The automation-change gate is removed. `docs/charter.md` becomes a sensitive
  path, and the security review rejects any change to it. The two top designs
  and `docs/design-tree.md` become sensitive paths too, so the maintainer's
  recorded decisions in them, as design section 5 defines them, are
  protected. A PR that cites a maintainer answer to change one is accepted
  only when the scheduler has verified the answer.
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
- Standing agents, the findings filer, the action log, and re-triaging
  abandoned issues (spec C). Abandonment appends a finding to the existing
  queue (spec 001 AC-28); nothing consumes it yet.
- Metrics (spec D). The records this spec writes (the escalation ledger, the
  questions log) are the raw events D will read.
- Intake and grilling. The authority and validated gates are unchanged.
- Firmware release (spec G).

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
Each criterion names the spec 001 criterion it replaces where there is one.
Section 4 is the single source for the chain's transitions; the criteria
below say what each path must do.

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
- AC-4. **A merged spec PR is checked again, then the work goes on.** Given
  the spec stage returns `revised` with a PR, then that PR goes through the
  scope check of AC-22, verify, review and merge. Review uses the `spec`
  profile; when the diff touches a sensitive path, the `security` review
  follows it (AC-9).
  The PR has its own fix counter, bounded like the issue's fix loop. After the
  merge:
  - `spec-<issue>` is deleted in the worktree and on GitHub;
  - the merge is not recorded in the shortlist's feature-to-debt merge record;
  - the scheduler runs spec-present (with the parent checks of AC-23) and the
    UI-design gate again, on `origin/main`.

  Given both pass, then the chain continues with fresh stage counters,
  reading the spec from `origin/main`: at a fix on the parked issue PR when
  there is one (AC-18), otherwise at plan. Given spec-present fails, then it
  is a bound hit with the spec stage as the stuck stage, under the spec-track
  rule of AC-5: the spec stage runs again in `write` mode with the reason, or
  the issue is abandoned. Given the UI-design gate fails, then the issue
  receives `needs-design-stage` as in AC-20 and the claim is released; the
  escalation ledger is kept.
- AC-5. **After a revision, the next bound ends in abandonment.** Given a spec
  revision has merged for the issue, when a bound from AC-1 is hit again,
  then:
  - the issue's PR (and a parked issue PR, AC-18) is closed, its branch saved
    as a patch and deleted;
  - the issue receives the `abandoned` label before `in-progress` is removed,
    and an informational comment that names the bounds hit and links the run
    records. The comment does not @-mention the maintainer and asks nothing
    of them;
  - the issue stays open; the shortlist skips any issue labelled `abandoned`.
    The recovery path is spec C's re-triage (design section 11). The
    maintainer may remove the label, but is not asked to;
  - one finding naming the issue and the bounds hit (from the ledger of AC-7)
    is appended to the findings queue;
  - one notification is sent.

  Given the scheduler stops partway through an abandonment, then the next
  tick finishes it from the first step not yet done; no step is repeated other
  than the one in flight when it stopped.

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
  - one release for repeated chain errors (`MAX_CHAIN_ERRORS`, AC-7); the
    next is a bound hit that abandons the issue;
  - six hours of pending required checks (`VERIFY_PENDING_MAX_H`), before the
    re-run of AC-17 and again after it.

  All are counted per issue. A test asserts their values. No stage definition
  or prompt can change them.
- AC-7. **Escalation state is per issue and survives a release.** Given an
  issue whose chain has used any escalation bound and was then released (for
  example by liveness) and claimed again, then the new chain starts with the
  same counters and history. They are kept in `escalations/<issue>.json` in
  the state directory, written whenever a counter or the history changes, and
  read when the issue is claimed and when it is abandoned. At abandonment the
  ledger is archived, so an issue whose `abandoned` label is later removed
  starts with fresh counts. The history gains an entry on every failed run,
  scope violation, `changes_requested` and check failure, not only when a
  bound is hit. Each entry is capped in length, and the last 20 are kept.
  Given a claim file written before this spec (with `securityFinding` and
  without the new fields), when it is read, then it loads with defaults and
  its chain continues.

  **An answer not yet recorded survives a release.** Given a product or
  technical answer (AC-18) that is not yet on `main`, then the ledger holds
  it (the answered question ids, the kind and the reply text) until the PR
  that records it merges. Given such an issue is released (liveness, or
  repeated chain errors) and claimed again, or re-planned, then the chain
  does not start at plan: the spec stage runs in `record` mode with that
  answer (or in `write` mode with it, when the spec is missing), and its spec
  PR must carry the mark; plan runs after it merges.

  **Repeated chain errors.** Given the scheduler's driver fails on a chain
  three times in a row (`MAX_CHAIN_FAILURES`), then the claim is released
  with an issue comment quoting the last error (with no @-mention), one
  finding, a history entry and one notification, and the release is counted
  in the ledger (AC-6); the next such release abandons the issue (AC-5). The
  consecutive failure count and the last error are kept in the claim and the
  ledger, so a restart does not reset them. A claim that carries work the
  driver must finish (a resume's `answered` event or an abandonment's
  actions) is never released; when it has failed three times in a row, one
  notification says so.

**Review escalation and security** (replaces AC-11)

- AC-8. **An escalation must say why.** Given a review result with verdict
  `escalate`, then it validates only if it carries an `escalation` object:
  - `kind`: `product`, `technical`, `capability` or `other`;
  - `question`;
  - `options`: each with a label and a cost;
  - `recommendation`.

  Given kind `other` (and not a follow-up, AC-15), the chain treats it as a
  bound hit with the fix stage as the stuck stage and the escalation as input
  (a rescue fix, and the path continues as in AC-2 to AC-5). Given any other
  kind, the question goes to the question check (AC-12).
- AC-9. **Security findings go to the fix loop.** Given a diff touching a
  sensitive path, then review runs twice in sequence: the normal review
  (the domain profile, or the `spec` profile on a spec PR), and, after its
  approval, the review with the `security` profile. The security review does
  not replace the normal one. Given either returns findings, then:
  - a fix stage runs with those findings as input;
  - after verify, both reviews run again, fresh, in the same order;
  - the PR merges only when both approve with no findings.

  No `security-review` or `needs-human` label is applied. `merge_blocked` and
  the `securityFinding` hold on merge are removed.
- AC-10. **The charter and the maintainer's recorded decisions are
  protected.** Given a diff touching `docs/charter.md`, then:
  - it is sensitive, because `agents/sensitive-paths.txt` lists it;
  - the security profile's review criteria include a rule that any change to
    `docs/charter.md` is a finding;
  - the fix stage's input from that finding says to revert the change.

  Given a diff touching `docs/product-spec.md`,
  `docs/delivery-system-design.md` or `docs/design-tree.md`, then it is
  sensitive (all three are listed), and the security criteria apply design
  section 5:
  - **Protected** are the maintainer's recorded decisions: the statements of
    the delivery design not marked *(author's call)*, including all of its
    section 3; the recorded product decisions in `docs/product-spec.md`; and
    the decision entries in `docs/design-tree.md`. Changing, removing or
    adding one is a finding unless the PR cites a verified maintainer answer
    that it carries out.
  - **Not protected** are statements marked *(author's call)* and the
    editorial and tracking parts: the delivery design's section 11 table, its
    section 12, and the `## Children` section of either top design. These
    change with the reviewed PR alone.
  - **A citation counts only if the scheduler verifies it.** A citation has
    the form `(maintainer answer, question #<question comment id>)`. Before
    any review, the scheduler checks every id the diff cites: it is verified
    when `questions/log.jsonl` has an `answered` entry with that question
    comment id (the log is the only source, as design section 5 states). The
    review input lists each cited id as verified or
    not, with the question and the answer; the criteria accept only a
    verified id.
  - Text anywhere marked as a recorded answer (AC-18) is changed or removed
    only by a PR citing a verified answer to a newer question; otherwise
    that is a finding.

  Given a diff that removes any of these four entries from
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
  plan, implement or fix result, or the verify bound of AC-17), other than a
  follow-up (AC-15), then the question check stage runs first, in a fresh
  session, with:
  - the question;
  - the design's section 3 rules, including its narrowed product-decision
    rule (big-picture choices about what panelator is and promises; a detail
    a user could notice that keeps those promises is not one);
  - the design's section 5 rule that a request to change a recorded
    maintainer decision (AC-10) is a question for the maintainer;
  - the spec;
  - the history;
  - the questions already answered on the issue, each with its question
    comment id, question and answer, from `questions/log.jsonl`. When one
    already settles the question, the check returns `decide_yourself`
    citing it.

  It returns `send` or `decide_yourself`, with reasoning. A question that asks
  to change a recorded maintainer decision is always `send`. With `send` it
  may return a `question` (AC-8's shape): the question as the strong-tier
  check words it, which is what the maintainer is sent (its question, options
  and recommendation); the asking stage's kind is kept, since it routes the
  answer. Given the check
  fails, it is retried once (the fallback of AC-26 applies first); a second
  failure is a bound hit for the stage that asked (AC-1).
- AC-13. **A sent question pauses the issue.** Given `send`, then, in this
  order:
  - the chain state, the asking stage, the question and a new random nonce
    are written to `paused/<issue>.json` in the state directory;
  - one issue comment headed "Question for the maintainer" is posted. It
    @-mentions the maintainer login from `agents/scheduler.yaml`, carries
    the options, the cost of each and the recommendation, and ends with the
    nonce as a hidden HTML comment (`<!-- panelator-question:<nonce> -->`).
    Its comment id and GitHub's creation time are stored in the paused
    record;
  - the issue receives `needs-decision`, then loses `in-progress`;
  - one notification is sent;
  - the claim is released.

  No stage of the issue runs until it is answered, and the shortlist treats an
  issue with a paused record as claimed. A crash between any two steps is
  completed on the next tick from the record, without a second question
  comment: recovery adopts a bot comment only when it carries the record's
  nonce, never an earlier question's comment.
- AC-14. **Anything else is sent back to decide.** Given `decide_yourself`, then
  the stage that asked runs again with the check's reasoning as input, and
  must decide the question it was sent back with:
  - a spec stage in `decide` mode must return `revised`;
  - a review must return `approve` or `changes_requested`;
  - a plan, implement or fix result must not carry an `escalation`.

  The one exception is a new blocker the decision does not settle: a
  question marked `new_blocker: true` that is of kind `capability` or of a
  different kind from the question sent back goes to the question check as
  usual. Any other result counts as a failed run. Given the asking stage is verify
  (AC-17), `decide_yourself` is a bound hit with the fix stage as the stuck
  stage and the reasoning as its input. A spec stage `question` of kind
  `other` is not sent to the check: it counts as a `decide_yourself` with the
  reasoning "kind other is not a question for the maintainer". A second
  question from the same stage on the same issue goes to the check again. A
  second `decide_yourself` on the issue is a bound hit on the escalation path
  (AC-1 to AC-5).
- AC-15. **The maintainer's reply resumes the issue.** Given an issue labelled
  `needs-decision` with a `paused/` record, when a poll finds a comment by the
  maintainer whose id is higher than the question comment's id and whose
  creation time is later, then, in this order:
  - the paused record is marked `resuming` with the reply, and `answered` is
    logged;
  - a claim is written holding the saved state and the `answered` event, not
    yet applied;
  - the issue receives `in-progress`, then loses `needs-decision`;
  - the paused record is removed;
  - the chain starts. Its first step applies the `answered` event like any
    other event (the section 4 transition, its actions and the ledger write),
    so the chain continues at the stage AC-18 names, in a fresh session with
    the question and the reply as input.

  Given the scheduler stops partway, then the next tick finishes the resume
  from the record before the chain starts, with no second claim and no second
  `answered` line. The resumed issue takes the next free slot before any
  shortlisted issue, including priority-labelled ones. A comment from anyone
  else, or one older than the question, does nothing. A record whose issue
  already has a running chain is not resumed again. A paused issue the
  maintainer closes has its record dropped.

  **Follow-ups.** Given a stage that runs with the maintainer's reply as input
  returns a question marked `follow_up: true` whose `reply_quote` is found in
  that reply (the reply asked for more detail, or asked a question back, and
  the question answers it), then it is a follow-up: the chain pauses again at
  once (AC-13), without the question check, and the question is logged as
  `asked`. A follow-up is not a failed run and counts toward no bound. Any
  other question from a stage with a reply as input goes to the question
  check as usual (AC-12). Given the follow-up is answered, then the second
  reply adds to the first: the stage gets both, each prefixed with its
  question id; every answered id of the chain is kept; the strongest kind
  (product, then technical, then capability) routes the answer as AC-18
  says; and the mark of any of those ids records it.
- AC-16. **One reminder, no timeout.** Given a question unanswered for 24
  hours, then one reminder is sent: an issue comment that @-mentions the
  maintainer, and one notification. No second reminder is sent. The issue is
  never abandoned or released for lack of an answer.
- AC-17. **Any stage can report what it cannot do.** Given a plan, implement or
  fix result that carries an `escalation` (kind `capability`, `product` or
  `technical`; `other` does not validate there), then the question goes to the
  question check (AC-12) with that stage as the asking stage. A result with an
  `escalation` need not carry the stage's other required fields, and the
  scheduler skips its PR, scope and plan-domain checks. Given a PR whose
  required checks have stayed pending for six hours since verify first saw
  them pending, then:
  - the scheduler re-runs, once, each pending required check that has a
    workflow run;
  - a fix stage runs with an investigation of the workflow as input: the
    pending check names, whether each has a run, and the workflow files
    that should produce them;
  - verify starts a new six-hour window.

  The fix input also says that a check found obsolete is reported as a
  finding naming its `required_checks` entry, for agents to remove in their
  own reviewed PR. Given the checks are still pending at the end of that
  window, then the chain raises a question of kind `capability` ("a required
  check never reported"), with verify as the asking stage, through the
  question check. Its only option is the one agents cannot take: the
  maintainer fixes the cause outside the repository.
- AC-18. **Answers are recorded before the chain continues.** Every recorded
  answer is marked where it is written with
  `(maintainer answer, question #<question comment id>)`. Given the
  maintainer's answer to a `product` question, then it is written into
  `docs/product-spec.md`, or into the top design it belongs to, through a spec
  PR that carries the mark:
  - asked by the spec stage: the spec stage resumes in its mode and records
    it in its own spec PR;
  - asked by plan or implement: the spec stage runs in `record` mode; after
    that spec PR merges, plan runs;
  - asked by review or fix: the issue PR is parked, the spec stage runs in
    `record` mode, and after that spec PR merges, the parked PR is restored
    and a fix stage applies the decision. Verify and a fresh review follow.

  Given the answer to a `technical` question, then:
  - asked by the spec stage: the spec stage resumes in its mode and writes it
    into the spec, or into an ADR under `docs/decisions/`, in its spec PR;
  - asked by plan or implement: the spec stage runs in `record` mode and
    writes it the same way; after that spec PR merges, plan runs;
  - asked by review or fix: the fix stage runs with the answer as input,
    records it as an ADR under `docs/decisions/` in the issue PR, and applies
    it. A fix result whose diff adds no file there carrying the mark is a
    failed run. Verify and a fresh review follow.

  A spec PR that records an answer and whose diff does not carry the mark is
  a failed run. On an issue PR, an ADR the diff adds under `docs/decisions/`
  is always in the plan's scope: an agent records its own large decision
  there (design section 3, item 2). An edit to an existing ADR is in scope
  only for a fix recording an answer, or when its added lines carry a
  verified mark. Given an answer to a `capability` question, the asking stage
  runs again with the answer as input (verify starts its six-hour window
  again); it is not a decision, so nothing beyond the log is recorded and no
  ADR is required. The answer stays an input only until the stage it resumed
  succeeds, or, for verify, until verify moves on to review or fix. Every
  question is logged in `questions/log.jsonl` in the state directory, one line
  per event, each with the issue, the asking stage, a timestamp and, once
  sent, the question comment id:
  - asked, with the question;
  - checked, with the verdict and reasoning;
  - sent;
  - reminded;
  - answered, with the reply's comment id and the answer.

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

  Given the issue body has a `Spec:` line, then `spec_path` must equal it, or
  the result is a failed run. Given it has none, then the scheduler appends
  `Spec: <spec_path>` to the issue body.

  **Branch.** The PR is from branch `spec-<issue>` into `main`. Every entry
  into the spec stage puts the chain on the spec track, so the spec stage, a
  question check it asks and its spec PR all use `spec-<issue>`. The
  scheduler creates that branch from `origin/main` and checks it out in the
  issue's worktree before the spec stage runs; the stage commits on it and
  pushes it, and does not create or switch branches. The PR body refers to the
  issue as `Refs #<issue>`; a spec PR whose body contains a closing keyword
  for any issue is a failed run. Given a claim on the spec track is released
  (liveness, or repeated chain errors, AC-7), then its spec PR is closed and
  `spec-<issue>` is deleted, so the next claim starts the spec work again from
  `origin/main`.

  **A branch left by a failed attempt.** Given a stage is about to run with
  no PR bound (on either track: a retry, a rescue, a re-plan, a revision, or
  a claim after a release) and the chain's branch (`issue-<issue>` or
  `spec-<issue>`) exists on origin, then before the stage runs its commits
  are saved as a patch, every open PR from it is closed with a comment, and
  the branch is deleted on GitHub, so the stage's push and PR start clean.

  **Scope.** The scope check of AC-22 holds the spec PR to:
  - the spec's directory;
  - `docs/designs/`;
  - `docs/decisions/`;
  - the `Children` section of the spec's parent design file. The parent must
    be one of the two top designs or a file under `docs/designs/`; the charter
    is never an allowed parent;
  - either top design in full, only while the chain records a maintainer's
    product answer (AC-18). Both are sensitive, so the security review checks
    the citation (AC-10).

  **Review.** Review of a spec PR uses the `spec` profile; when the diff
  touches a sensitive path, the `security` review runs after it and both
  must approve (AC-9). The `spec`
  criteria: the spec fits its parent design and the issue body; it has the
  spec field set; it does not decide a section 3 question itself; it changes
  or removes no text marked as a recorded answer unless it cites a verified
  answer to a newer question (AC-10).
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
  then it is retried once on the fallback in a fresh session. Given the
  fallback run also fails with a quota or rate-limit error, then the stage is
  postponed, as any strong-tier stage is (spec 001 AC-25). The usage record
  names the model that produced the result, and accepts the `spec` and
  `question-check` stage names. On pi, plan, review and the question check
  run with read-only tools only, so none can write its result file: given
  the file is missing, the scheduler takes the result from the last JSON
  object in the run's final assistant message, validated like a file.

**No human stop is left**

- AC-27. **No path ends in `needs-human`.** The `NEEDS_HUMAN` constant and the
  `needs-human` chain stage no longer exist. The chain module has a
  table-driven test that feeds every event shape to every chain stage:
  - every pair section 4 marks valid must not throw;
  - every other pair must throw the machine's invalid-event error, and any
    other exception fails the test;
  - no valid pair leads to a state that waits on a human other than `paused`
    (AC-13);
  - a failure postponed for quota is handled before every other failure rule:
    in a rescue run it postpones the rescue, which stays a rescue and is not
    spent.

  The ended states are `done`, `released`, `abandoned` and `paused`.
- AC-28. **End-to-end chains are recorded.** Recorded end-to-end tests (fake
  adapter, mocked GitHub) drive these chains to their end and assert the label
  and comment sequence:
  - rescue then merge;
  - re-plan then merge;
  - spec revision then merge;
  - a question paused, answered, recorded and merged;
  - a reply that asks a question back, a follow-up, a second reply, recorded
    and merged;
  - a `decide_yourself` then merge;
  - a capability question from implement, paused and answered, then merged;
  - an abandonment;
  - a security finding fixed then merged;
  - a spec PR that touches the charter, never merged (AC-22).

## 4. Chain changes

The spec 001 section 5 table, as amended. Rows not listed are unchanged. This
table is the single source for the chain's transitions; the plan implements
it and adds only the state fields each row sets. Where several rows match, the
first wins.

| From | Event | To |
|---|---|---|
| claimed | start, an answer not yet recorded (AC-7) | spec (`record`, or `write` when the spec is missing), with the answer |
| claimed | start, spec ok | plan |
| claimed | start, spec missing or incomplete | spec (`write`) |
| any agent stage | failed, postponed for quota | waiting, then the same stage (spec keeps its mode; a rescue stays a rescue and is not spent) |
| any agent stage | failed, in a rescue run | escalate at once, no retry |
| plan, implement, review | failed, retry used | escalate |
| spec | failed, retry unused | spec, same mode, attempt 2 |
| spec | failed, retry used | escalate (stuck: spec) |
| question check | failed, retry unused | question check, attempt 2 |
| question check | failed, retry used | escalate (stuck: the asking stage; verify: fix) |
| plan | `spec_gap`, no gap answered yet | spec (`answer`) |
| plan | `spec_gap` after an answered gap | escalate (stuck: plan) |
| any agent stage run with a reply as input | result with a question marked `follow_up` quoting the reply (AC-15) | paused, without the question check |
| plan, implement, fix | result with an `escalation`, in decide mode, a new blocker (AC-14) | question check |
| plan, implement, fix | result with an `escalation`, in decide mode | failed run |
| plan, implement, fix | result with an `escalation` | question check |
| implement, fix | scope violation, second time | escalate |
| fix | failed | escalate |
| any route to fix | fixes = 2 | escalate (stuck: fix) |
| verify | checks pending 6 hours, not yet re-run | re-run the pending checks; fix (workflow investigation); a new 6-hour window |
| verify | checks pending 6 hours after the re-run | question check (kind `capability`, asking: verify) |
| verify | checks green or failed after a reply | review or fix, the reply no longer an input |
| review | `escalate`, kind `other` | escalate (stuck: fix, escalation as input) |
| review | `escalate`, other kinds, in decide mode, a new blocker | question check |
| review | `escalate`, other kinds, in decide mode | failed run |
| review | `escalate`, other kinds | question check |
| review | findings, sensitive diff (either review) | fix (findings as input); after verify both reviews again |
| review | `approve`, sensitive diff, normal review | review with the `security` profile |
| review | `approve` | merge (no security hold) |
| spec | `revised`, scope ok | spec track: verify, review (`spec` or `security` profile), merge |
| spec | `revised`, scope violated | spec track: fix with the violations; a second violation escalates |
| spec | `question`, in decide mode, a new blocker | question check |
| spec | `question`, in decide mode | failed run |
| spec | `question`, kind `other` | as `decide_yourself` from the check (counted) |
| spec | `question`, other kinds | question check |
| merge, spec track | merged, spec-present and UI design pass on `origin/main`, a parked issue PR | delete `spec-<issue>`; the parked PR restored; fix applying the answer, fresh stage counters |
| merge, spec track | merged, both pass, no parked PR | delete `spec-<issue>`; plan, fresh stage counters |
| merge, spec track | merged, spec-present fails on `origin/main` | delete `spec-<issue>`; escalate (stuck: spec, `write` mode with the reason) |
| merge, spec track | merged, UI design missing on `origin/main` | delete `spec-<issue>`; `needs-design-stage`; released, ledger kept |
| question check | `send` | paused, with the check's wording of the question |
| question check | `decide_yourself`, asking verify | escalate (stuck: fix, reasoning as input) |
| question check | `decide_yourself`, first on the issue | the asking stage, decide mode |
| question check | `decide_yourself`, second on the issue | escalate (stuck: the asking stage) |
| paused | any reply | the reply added to any answer not yet spent (AC-15); the strongest kind routes the rows below |
| paused | reply to a spec question | spec, same mode, with the answer |
| paused | reply to a capability question | the asking stage, with the answer (verify: a new 6-hour window) |
| paused | reply to a product question from plan or implement | spec (`record`) |
| paused | reply to a product question from review or fix | issue PR parked; spec (`record`) |
| paused | reply to a technical question from plan or implement | spec (`record`) |
| paused | reply to a technical question from review or fix | fix, recording an ADR |
| any stage but the ended ones | liveness expired | released; on the spec track the spec PR closed and `spec-<issue>` deleted; an unrecorded answer kept in the ledger |
| any stage but the ended ones | chain error, no chain-error release used (AC-7) | released as on liveness, with the error, a finding and a history entry |
| any stage but the ended ones | chain error, chain-error release used | abandoned |
| escalate | stuck spec or spec track, spec-track rescue unused | rescue of the stuck stage |
| escalate | stuck spec or spec track, spec-track rescue used | abandoned |
| escalate | issue track, no rescue used | rescue of the stuck stage |
| escalate | issue track, rescue used, no re-plan used, an answer not yet recorded | re-plan: spec (`record`) with the answer, then plan |
| escalate | issue track, rescue used, no re-plan used | re-plan |
| escalate | issue track, re-plan used, no spec revision used | spec (`revise`) |
| escalate | issue track, spec revision used | abandoned |

`escalate` is not a resting state: it is the transition rule the table names,
applied immediately. Every transition into the spec stage sets the spec
track.

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
- `liveness_expired` and `chain_error`: every stage except `done`,
  `released`, `abandoned` and `paused`.

## 5. Interfaces and files

- `tools/scheduler/src/chain/`:
  - `types.ts`: new stages `spec`, `question-check`, `paused`, `abandoned`;
    `needs-human` removed; in `ChainState`, the escalation counters, the
    history, the track, the asking stage, the answer with its question ids and
    kind, the answer not yet recorded, the record-answer flag, the decided
    question's kind, the security-review pass, the chain-error counts, the
    parked issue PR, and the verify pending time and re-run flag; the
    `chain_error` event; the `close_pr`, `delete_branch`, `finding`, `pause`
    and `rerun_checks` actions; `merge_result` carries the post-merge gate
    result on the spec track.
  - `machine.ts`: the section 4 rows, the AC-6 constants, and the
    normalization of a stored chain state (AC-7).
  - `driver.ts`: rescue model selection from the state, PR close, the spec PR
    sub-chain and its scope check, branch preparation, the post-merge gates,
    citation checks for review, pause, the pending event of a resume and the
    pending actions of an abandonment, the escalation ledger and the
    questions log.
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
  comments with id, author and time; read one issue comment by id; `comment`
  returns the new comment's id and creation time; close a pull request; list
  the open pull requests from a branch; delete a branch; set an issue body; a pull request's body; re-run a workflow run.
- `tools/scheduler/src/runner/worktree.ts`: check out a named branch from a
  base, and delete a local branch.
- `tools/scheduler/src/runner/retry.ts`: the independent fallback and the
  postpone after it (AC-26).
- `tools/scheduler/src/config.ts`: `rescue_model`.
- `tools/scheduler/src/state/`: paused records, the escalation ledger, the
  questions log, and claim normalization on read; claims may carry a pending
  event or pending actions.
- `tools/scheduler/src/stages/definition.ts`, `src/stages/prompt.ts` and
  `src/types.ts`: stage names `spec` and `question-check`; `independent`;
  spec modes `write`, `answer`, `revise`, `decide` and `record` passed in the
  stage input; the `escalation` field on plan, implement and fix results;
  the answered-questions input of review.
- `tools/scheduler/test/`: the tests named in section 6.
- `agents/stages/spec.md` (strong tier, Claude) and
  `agents/stages/question-check.md` (strong tier, pi with an OpenAI model,
  `independent: true`, Claude fallback; design sections 3 and 5 rules).
- `agents/stages/plan.md`, `agents/stages/implement.md`,
  `agents/stages/fix.md` and `agents/stages/review.md`: the history, answer
  and decide inputs; the `escalation` object and when to use it; follow-ups;
  plan's spec questions go to the spec stage, not the maintainer; review's
  answered-questions input.
- `agents/profiles/spec/`: `profile.yaml`, `instructions.md`,
  `review-criteria.md` (AC-21).
- `agents/profiles/security/review-criteria.md`: the rules of AC-10;
  `instructions.md`: "any finding blocks merge until the maintainer looks"
  replaced by "findings go to the fix loop".
- `agents/sensitive-paths.txt`: add the charter's path, the two top designs
  and `docs/design-tree.md` (this spec does not list the charter itself, so
  the scope gate keeps it out of the diff).
- `agents/scheduler.yaml`: `rescue_model`.
- `schemas/scheduler/`:
  - `question.json`, with the optional `follow_up` (requiring
    `reply_quote`) and `new_blocker`;
  - `spec-result.json`;
  - `question-check-result.json`, with the optional `question` of `send`;
  - `paused.json`, with the nonce;
  - `escalation-ledger.json`, with the answer not yet recorded and the
    chain-error counts;
  - `question-log-entry.json`, with the question comment id;
  - `review-result.json`, `plan-result.json`, `implement-result.json` and
    `fix-result.json` gain `escalation`; `plan-result.json`'s `spec_gap` rule
    applies only when a verdict is present;
  - `usage-record.json`: the `stage` enum gains `spec` and `question-check`;
  - `stage-input.json` gains `history`, `question`, `answer`, `mode`,
    `decide_input`, `spec_problem`, `answered_questions`;
  - `claim.json` follows `ChainState`, and gains the pending event and
    pending actions.
- `specs/001-*` to `specs/005-*`: `Parent:` line. Spec 001's status line gains
  "amended by spec 006". Its section 2 spec numbers for the shortlist,
  Telegram and filing agent are corrected to name design specs A and C.
- `docs/delivery-system-design.md`: `Parent:` line and `## Children` section.
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
  - the stage prompt files carry the new inputs (AC-1, AC-14, AC-15, AC-17);
  - the AC-26 fallback against recorded pi and Claude streams;
  - the recorded end-to-end chains of AC-28.
- After the service is restarted on the merged code, the first real issue
  that reaches any escalation step is written up in `dev-logs/` with its run
  records.

## 7. Open decisions

None.
