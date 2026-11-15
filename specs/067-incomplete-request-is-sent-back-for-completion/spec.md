# 067. An incomplete credential, funds or first-contact request is sent back for completion, not for a decision

Status: written 2026-11-15 from the delivery-system design for issue #129;
specs derived from that design need no maintainer approval (design section 11).
Amends [030-beyond-github](../030-beyond-github/spec.md) AC-6 (an incomplete
request is sent back for completion, not returned as `decide_yourself`) and
its section 6 (the recorded run "a credential question without `setup`"), and
[006-no-human-stops](../006-no-human-stops/spec.md) AC-12 (the question check
has a third verdict, `incomplete`) and AC-14 (a `new_blocker` question with an
incomplete request is completed before the check), each marked as section 4
records. Decision recorded in
[ADR 0012](../../docs/decisions/0012-incomplete-request-is-an-invalid-result.md).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 (item 3, "What agents cannot do": credentials and access, funds,
first contact; "Who judges": the check sends a question back only when it is
not one of the three kinds), section 4 ("every other blocker is resolved by
agents"; a failed run is retried and bounded by the chain's own counts),
section 8 ("Credentials": a request names the exact access and gives
step-by-step setup; "Funds": what for, the amount, the charter goal; "First
contact": who, why, what it would send) and section 10 ("Small work skips
layers": a bug spec hangs directly off a top design);
[process-spec](../../docs/process-spec.md) 4.2 step 3 (a design flaw an agent
settles is recorded as an ADR);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-22 (a result that fails
validation is a failed run with `result: invalid`);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-8 (the question
object), AC-12 (the check and its verdicts, amended here), AC-14 (decide mode
and its bound, amended here), AC-17 (verify's capability question, which
carries no request) and AC-18 (the questions log);
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 4 (the stages the question path resumes are not retries, so the
branch is kept); [030-beyond-github](../030-beyond-github/spec.md) AC-6 (the
`request` object and its fields, kept; its `decide_yourself` sentence,
amended here), AC-7 and AC-8 (what the scheduler does with a sent request,
unchanged); [062-capability-answer-settles-nothing](../062-capability-answer-settles-nothing/spec.md)
(the check's judgement of capability answers, unchanged and not relied on).

## 1. Goal

A chain stage that raises a credential, funds or first-contact need and
leaves a field of its `request` out, or leaves the `request` out altogether,
is told which fields are missing and asks again with the request completed.
The completed request reaches the maintainer. Forgetting a field is treated
as what it is, a malformed result, and never as a question the stage was
told to decide for itself.

### What is wrong today

Spec 030 AC-6 says that a capability question for one of the three needs
whose `request` is missing or has an empty field is returned by the question
check (spec 006 AC-12) as `decide_yourself` with the reason "a <type> request
must give <fields>", "and the stage is in `decide` mode as today". Three
rules then close every way back:

- In decide mode a stage may not ask the sent-back question again in any
  wording (`agents/stages/implement.md` lines 77 to 82, the same paragraph
  in `plan.md`, `fix.md`, `review.md` and the `decide` mode of `spec.md`);
  a question not marked `new_blocker` fails the run
  (`tools/scheduler/src/chain/machine.ts`, `ask()`: `if
  (question.new_blocker !== true) return failedInDecideMode(state, stage)`).
- A `new_blocker` question goes to the check "with the question sent back
  and its reasoning beside it", and the check returns `decide_yourself` when
  "it is the same question in other words" (spec 006 AC-14). A request
  completed with the missing field is the same question in other words.
- A second `decide_yourself` on the issue is a bound hit
  (`MAX_DECIDE_RETURNS` is 1; `decideYourself` escalates the asking stage).

So a stage that forgot `setup` on a credential request, or `charter_goal` on
a funds request, can either decide without the credential, the funds or the
approval, which for a maintainer-only capability is impossible, or spend the
issue's escalation path. Spec 006 AC-12 gives the check only `send` and
`decide_yourself`, so spec 030 had no other verdict to use. The review stage
of issue #39 noticed it (run `39-review-1-20261104T182246`); the filer
confirmed it against `main` at d352750. Spec 030 is not implemented (issue
#39 is labelled `abandoned`), so the flaw is in spec text and nothing on
`main` has to be undone.

### The fix

An incomplete request is an invalid result, judged where every question of
every stage already passes, and sent back for completion with the asking
stage's work held. Three parts:

1. **The request's shape is in the schema, its completeness is the chain's
   rule** (AC-1, AC-2). `schemas/scheduler/question.json` gains the
   `request` object of spec 030 AC-6. `checkRequest(question)` in
   `tools/scheduler/src/chain/question.ts` names every missing or empty
   field as "a <type> request must give <fields>". `ask()` in the chain
   machine applies it to every question a stage result carries: an
   incomplete request runs the asking stage again, holding the work it
   committed before the question (spec 011), with the reason in its history,
   in the same mode, counting no `decide_yourself` and entering no decide
   mode. A second incomplete request on the same claim is a failed run of the
   asking stage with the reason, under spec 006's rule for that stage's
   failure. The check never sees an incomplete request.
2. **The check has a verdict for the case code cannot see** (AC-3). Whether a
   question's text asks for a credential, funds or an outside party is a
   judgement; only the check can notice that such a question carries no
   `request`, or one of another type. For that case the check returns a third
   verdict, `incomplete`, with the same reason, and the machine takes the
   same path as for part 1.
3. **The prompts say so** (AC-4). The paragraph on the `request` object that
   spec 030 section 5 gives the five asking stages is added here, in the
   form this spec fixes: the fields of each type, that an incomplete request
   comes back once with the missing fields named in the history, that
   completing it is not asking the question again, and that a second
   incomplete request is a failed run.

*(agent's call)* The other amendment the filer offered, exempting a request
completed after a "must give <fields>" return from counting as the same
question in decide mode, was weighed and rejected: it would make the rule
turn on the check's judgement of "same question" each time, it would still
spend the issue's one free `decide_yourself` (spec 006 AC-14), and it would
contradict the decide-mode paragraph of every stage prompt, which spec 062
and the check rely on. A third option, the check completing the request
itself and sending it, was rejected because the check does not have the
asking stage's knowledge (the scopes it found it needs, the amount, the
message it would send) and the maintainer would act on a guess. Completeness
is judged in the machine rather than by `required` in the schema so that the
run reaches `ask()`, which holds the committed work (spec 011) and names the
fields in the stage's own words; a schema failure in the runner (spec 001
AC-22) would fail the run before the work is held and report ajv's wording.
ADR 0012 records the decision; it changes the check's verdict set, which
every asking stage's prompt and spec 006 AC-12 describe.

## 2. Out of scope

- The rest of spec 030: the store, the wrappers, the rendering of a sent
  request (AC-7), what the scheduler does with the answer (AC-8), the gate,
  the two standing agents. Spec 030 AC-6's definition of the `request`
  object and its fields is kept as written; only its last paragraph is
  amended. Whichever of this spec and spec 030 is implemented first adds the
  `request` object to `question.json` in the shape AC-1 gives; the other
  finds it there.
- The `decide_yourself` bound (spec 006 AC-14, `MAX_DECIDE_RETURNS`) and the
  check's judgement of a repeated question in decide mode. An incomplete
  request never reaches either.
- The follow-up rule (spec 006 AC-15) and the check's treatment of
  capability answers (spec 062): unchanged.
- Judging whether a question's `kind` is right, or whether a `request` on a
  question of another kind is a mistake: the check judges the kind as today.
- A request's content beyond presence and non-emptiness: whether `access` is
  least privilege, whether `charter_goal` names a real clause, whether
  `party` is well formed. The maintainer reads the request; spec 030 AC-7
  renders it in full.
- Verify's capability question (spec 006 AC-17): made by the scheduler, it
  carries no request and is never incomplete.
- Changing the sensitive-path list, the security review criteria or
  instructions, or what routes a sensitive diff to the security review.

## 3. Acceptance criteria

"Given" states use the chain machine's pure `transition` with fixture states
(`tools/scheduler/test/chain.test.ts`), the driver tests' fakes
(`tools/scheduler/test/driver.test.ts`) and the recorded worlds of
`tools/scheduler/test/helpers/e2e-routes.ts` with scripted stage results,
where it says so.

Definitions. A *request* is the `request` object of spec 030 AC-6 on a
question: `{ type: "credential", name, provider, access, setup }`, `{ type:
"funds", amount_usd, purpose, charter_goal }` or `{ type: "first_contact",
party, channel, why, message }`. A field is *empty* when it is absent, an
empty string, a string of whitespace only, an empty array, an array with an
empty string in it, or, for `amount_usd`, not a number greater than zero. A
request is *incomplete* when any field of its type is empty, or when its
`type` is not one of the three. The *reason* for an incomplete request is
`a <type> request must give <fields>`, the empty fields of that type in the
order above, joined with `, ` (for example `a credential request must give
access, setup`); for an unknown type it is `a request's type must be
credential, funds or first_contact`. `MAX_INCOMPLETE_REQUESTS` is 1.

- AC-1. **The request has a schema shape and a completeness check.**
  `schemas/scheduler/question.json` gains an optional `request` property:
  an object with `additionalProperties: false`, `type` required with the
  three-value enum, and the fields of all three types as optional
  properties (`name`, `provider`, `purpose`, `charter_goal`, `party`,
  `channel`, `why`, `message` strings; `access` and `setup` arrays of
  strings; `amount_usd` a number). No field is `required` in the schema
  except `type`, so that an incomplete request is a valid result that
  reaches the chain machine (section 1, "The fix"). Every stage result
  schema that refers to `question.json` accepts it unchanged. Given a
  question, when `checkRequest(question)` (new, pure, in
  `tools/scheduler/src/chain/question.ts`) runs, then it returns `null` when
  the question has no `request` or a complete one, and the reason string
  otherwise. Unit tests cover each type with every field present, each type
  with one field empty in each way the definition names, two empty fields in
  order, an unknown type, and a question without a request.
- AC-2. **An incomplete request runs the asking stage again, holding its
  work, outside decide mode.** Given a stage result that carries a question
  (a spec or design `question` verdict, a plan, implement or fix
  `escalation`, a review escalation), when `ask()` in
  `tools/scheduler/src/chain/machine.ts` handles it, then after the
  decide-mode rule (a question without `new_blocker` in decide mode still
  fails the run as today) and before the follow-up and question-check
  routing, `checkRequest` is applied:
  - given it returns a reason and `incompleteRequests` is below
    `MAX_INCOMPLETE_REQUESTS`, then the state's `incompleteRequests` is
    incremented, the history gains `<stage> attempt <n>: incomplete request:
    <reason>`, the work the result carried is held as `heldPatch` holds it
    for a question (spec 011; review holds nothing), and the asking stage
    runs again the way `resume` runs it after `decide_yourself`, except that
    `decideInput`, `decidedQuestion` and `decideReturns` are left exactly as
    they were: a stage not in decide mode is not put in it, a stage in
    decide mode stays in it with the same sent-back question. No
    `question-check` run, no pause, no `asked` or `checked` entry in
    `questions/log.jsonl`, no `decide_yourself` counted. The rerun is a
    stage the question path resumes in the sense of spec 011 section 4, so
    the branch is not cleaned as a retry's would be;
  - given it returns a reason and `incompleteRequests` is already
    `MAX_INCOMPLETE_REQUESTS`, then the result is a failed run of the asking
    stage with reason `result: invalid: <reason>`, handled as a
    `stage_failed` of that stage is handled today (spec 006: plan,
    implement, review, spec and design retry once then escalate; fix
    escalates), with `incompleteRequests` incremented and the history entry
    `<stage> attempt <n> failed: result: invalid: <reason>`;
  - given it returns `null`, then nothing changes: the follow-up rule and
    the question check apply as today.

  `incompleteRequests` is a new `ChainState` count (default 0, `newChain`
  sets it; `schemas/scheduler/claim.json` and
  `schemas/scheduler/escalation-ledger.json` allow it; `boundsText` prints
  `incomplete request <n>/1`). It is never reset within a claim. Chain
  tests: a plan escalation with a credential request lacking `setup` from a
  plain state reruns plan with the history line and `decideInput` null; the
  same in decide mode with `new_blocker: true` reruns plan with `decideInput`
  unchanged and `decideReturns` unchanged; an implement escalation with a
  funds request whose `amount_usd` is `0` reruns implement with its `head`
  held; a second incomplete request on the same state produces the failed
  run with the `result: invalid:` reason and follows that stage's failure
  rule; a spec `question` with a complete `first_contact` request goes to
  the question check as today; a question without a request is routed as
  today.
- AC-3. **The check returns `incomplete` for a request it cannot find.**
  `schemas/scheduler/question-check-result.json`'s `verdict` enum gains
  `incomplete`; `question` is left out on it. `agents/stages/question-check.md`
  gains, under a heading of its own, in these words or words that keep them:
  a capability question that asks for a credential, for funds or for a first
  contact with an outside party must carry a `request` of the matching type
  (spec 030 AC-6: `credential` gives `name`, `provider`, `access`, `setup`;
  `funds` gives `amount_usd`, `purpose`, `charter_goal`; `first_contact`
  gives `party`, `channel`, `why`, `message`). Given such a question carries
  no `request`, or a `request` of another type, return `incomplete` with
  `reasoning` `a <type> request must give <fields>`, naming every field of
  the type; the asking stage is run again to complete it, which is not a
  decision and not a `decide_yourself`. Given the question carries a request
  of the matching type, the scheduler has already checked its fields; judge
  the kind as before. Never return `decide_yourself` because a request is
  missing or incomplete. Given the check's result has verdict `incomplete`,
  when the machine handles its `stage_ok`, then it takes the path of AC-2's
  first two bullets for the asking stage with the check's `reasoning` as the
  reason (the work was held when the question was asked; the question log's
  `checked` entry records `verdict: incomplete` with the reasoning, and
  `schemas/scheduler/question-log-entry.json` allows it). The chain test
  covers `incomplete` from a check reached from plain state and from decide
  mode, and `tools/scheduler/test/stages.test.ts` pins the prompt: it
  contains `incomplete`, `must give` and `Never return \`decide_yourself\`
  because a request is missing`, and the full-input render succeeds.
- AC-4. **The asking stages are told the rule.** `agents/stages/plan.md`,
  `implement.md`, `fix.md`, `review.md` and `spec.md` each gain one
  paragraph, placed with the escalation rules, in these words or words that
  keep them: a capability question for a credential, funds or a first
  contact carries a `request` object with the fields of its type (listed as
  in AC-3, with spec 030 AC-6's meaning of each: `access` the exact scopes,
  `setup` the numbered steps the maintainer follows, `charter_goal` the
  clause served, `party` a stable identifier, `message` the full text that
  would be sent); a request with a field left out or empty, or a question
  of this kind without one, is sent back once with the missing fields named
  in the history, and asking again with the request completed is not asking
  the question again; a second incomplete request is a failed run. The
  decide-mode paragraph of each prompt is unchanged. `stages.test.ts` pins
  each of the five files on the phrase `request completed is not asking`.
- AC-5. **Live cases end to end.** Recorded worlds (`e2e.test.ts`, scripted
  results in `e2e-routes.ts`) drive and assert, beside spec 006 AC-28's
  capability case:
  - an issue-track chain whose implement run returns a capability
    escalation with a credential request lacking `setup`, whose second
    implement run (its input `history` carrying `incomplete request: a
    credential request must give setup`, its `held_work` naming the first
    run's head, its `decide_input` `(none)`) returns the same escalation
    with `setup` filled, whose check returns `send`, and which is answered
    and merges: the ledger ends with `incompleteRequests` 1 and
    `decideReturns` 0; the questions log for the issue reads `asked,
    checked, sent, answered` only; no `question-check` run exists for the
    first escalation; the `spec-<issue>` and `issue-<issue>` branch handling
    of spec 006 AC-21's "branch left by a failed attempt" did not run
    between the two implement runs (the first run's commit is the second
    run's starting head);
  - the same chain where the first escalation carries no `request` and the
    scripted check returns `incomplete` with the reason: the questions log
    reads `asked, checked (incomplete), asked, checked, sent, answered`, the
    second implement run's history carries the reason, and the chain merges;
  - a chain whose implement run returns an incomplete request twice: the
    second is `implement attempt 2 failed: result: invalid: a credential
    request must give setup` in the history and the chain continues under
    spec 006's rule for a failed implement attempt.
  The spec 006, 011, 015, 062 and 065 chain tests pass unchanged.
- AC-6. **The earlier text is marked.** Spec 030 AC-6 and section 6 and spec
  006 AC-12 and AC-14 carry the marks of section 4, and their earlier text
  follows unchanged.

## 4. Marks on earlier specs

- Spec 030 AC-6 is marked `Amended by
  [067-incomplete-request-is-sent-back-for-completion](../067-incomplete-request-is-sent-back-for-completion/spec.md)
  AC-2: an incomplete request is an invalid result sent back to the asking
  stage for completion, holding its work and outside decide mode (the
  check's verdict for one it finds is incomplete, AC-3), never
  decide_yourself.` Its first paragraphs, the `request` object and its
  fields, stand as written; its last paragraph's `decide_yourself` and
  "`decide` mode as today" no longer apply.
- Spec 030 section 6 is marked, as a block quote under its heading,
  `Amended by [067-incomplete-request-is-sent-back-for-completion](../067-incomplete-request-is-sent-back-for-completion/spec.md)
  AC-5: the recorded run "a credential question without setup" ends with
  the stage asked again holding its work and the completed request sent,
  not with decide_yourself.`
- Spec 006 AC-12 is marked `Amended by
  [067-incomplete-request-is-sent-back-for-completion](../067-incomplete-request-is-sent-back-for-completion/spec.md)
  AC-3: the check also returns incomplete, with the fields named, when a
  credential, funds or first-contact question carries no request of its
  type; the asking stage then runs again to complete it.`
- Spec 006 AC-14 is marked `Amended by
  [067-incomplete-request-is-sent-back-for-completion](../067-incomplete-request-is-sent-back-for-completion/spec.md)
  AC-2: a new_blocker question whose request is incomplete is sent back for
  completion before the check, and the stage stays in decide mode with the
  same sent-back question.`

Spec 006 AC-8, AC-15, AC-17 and AC-18, spec 011 and spec 062 are not
amended: the question object gains a field spec 030 already gave it, the
follow-up rule and verify's question are untouched, the log gains one
verdict value, and the held-work and capability-answer rules apply as
written.

## 5. Interfaces and files

- `tools/scheduler/src/chain/question.ts`: `checkRequest(question:
  Question): string | null` and the field lists per type (AC-1).
- `tools/scheduler/src/chain/machine.ts`: `MAX_INCOMPLETE_REQUESTS`;
  `incompleteRequest(state, stage, reason)` used by `ask()` and by the
  question-check case of `stageOk` on verdict `incomplete`; `boundsText`
  (AC-2, AC-3).
- `tools/scheduler/src/chain/types.ts`: `ChainState.incompleteRequests:
  number`; `Question.request?` in the shape of AC-1; `newChain` (AC-2).
- `tools/scheduler/src/chain/driver.ts`: `logQuestion` writes the `checked`
  entry for verdict `incomplete` as for the other verdicts; nothing else
  (AC-3).
- `schemas/scheduler/question.json` (`request`, AC-1),
  `question-check-result.json` (`incomplete`, AC-3), `claim.json` and
  `escalation-ledger.json` (`incompleteRequests`, AC-2),
  `question-log-entry.json` (`incomplete` among the verdicts, AC-3).
- `agents/stages/question-check.md` (AC-3); `agents/stages/plan.md`,
  `implement.md`, `fix.md`, `review.md`, `spec.md` (AC-4).
- Tests: `tools/scheduler/test/question.test.ts` (new, AC-1),
  `chain.test.ts` (AC-2, AC-3), `stages.test.ts` (AC-3, AC-4),
  `schema.test.ts` (the four schemas), `e2e.test.ts` and
  `helpers/e2e-routes.ts` (AC-5).
- `specs/030-beyond-github/spec.md` AC-6 and section 6,
  `specs/006-no-human-stops/spec.md` AC-12 and AC-14: the marks of section
  4 (this spec PR).
- `docs/decisions/0012-incomplete-request-is-an-invalid-result.md` (this
  spec PR).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/`, `schemas/scheduler/`,
`docs/delivery-system-design.md`, `specs/006-no-human-stops/spec.md` and
`specs/030-beyond-github/spec.md` are sensitive paths; the security review
applies to this spec PR (for the marks and the Children line) and to the
implementation PR (spec 006 AC-9). Nothing here changes the sensitive-path
list, the security criteria, what routes a sensitive diff to the security
review, that both reviews must approve, that a sensitive path must be listed
in the spec, section 3 of the design, or any text marked as a maintainer
answer. No new network call, listener or shell execution; no secret is read
or written: a request names a credential, never carries one.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-2 chain test for a plan escalation lacking `setup` fails on `main`
  before the change (the question goes to the check) and passes after it;
  the AC-3 prompt test fails on `main` (no `incomplete` in the check's
  prompt) and passes after it.
- `grep -n "decide_yourself" agents/stages/question-check.md` shows the
  sentence of AC-3 that forbids it for a missing request; `grep -c "request
  completed is not asking" agents/stages/plan.md agents/stages/implement.md
  agents/stages/fix.md agents/stages/review.md agents/stages/spec.md`
  prints 1 for each file (AC-4).
- `MAX_DECIDE_RETURNS`, `decideYourself` and the decide-mode paragraph of the
  five stage prompts are unchanged against `main`.
- Live check after deploy: the first capability question on any issue that
  carries a `request` is followed either by a `send` from the check or by a
  history line `incomplete request: a <type> request must give <fields>`
  and a second run of the same stage with `decide_input` `(none)` in its
  `prompt.md`; no `decide_yourself` whose reasoning contains `must give`
  appears in `questions/log.jsonl`. The PR that deploys it quotes the first
  such run.

## 7. Open decisions

None.
