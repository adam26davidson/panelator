# 062. An answer to a capability question settles nothing: a blocker that still stands after it gets a follow-up, not "decide it yourself"

Status: written 2026-11-14 from the delivery-system design for issue #122;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 (item 3, "What agents cannot do"; "What happens while it waits": a
reply that asks something back gets a follow-up and such an exchange counts
against no bound; "Recording": only product and technical answers are
decisions written somewhere) and section 10 ("Small work skips layers": a bug
spec hangs directly off a top design);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-12 (the question
check's input, which this spec amends and marks as section 4 records), AC-14
(the `decide_yourself` bound, unchanged), AC-15 (follow-ups and joined
replies, applied unchanged) and AC-18 ("Given an answer to a `capability`
question ... it is not a decision", which this spec carries into the check);
and [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md),
which keeps a host-refused run from reaching the question check at all and
which this spec neither changes nor relies on.

## 1. Goal

The question check treats a maintainer's answer to a capability question as
what it is: a report of an action outside the agents' reach, not a decision.
When a stage asks again because the blocker named in an answered capability
question still stands, the check sends the maintainer a follow-up that says
so, instead of returning "decide it yourself" and spending the issue's
escalation path on work no agent can do. A capability question put to the
maintainer says, for each option, who carries it out and what reply ends the
wait.

### What is wrong today

Spec 006 AC-12 gives the question check "the questions already answered on
the issue, each with its question comment id, question and answer" and the
rule "when one already settles the question, the check returns
`decide_yourself` citing it". `issueAnswers` in
`tools/scheduler/src/chain/driver.ts` builds that list from every `answered`
entry of `questions/log.jsonl` for the issue, as `#<id>: Question: ...
Answer: ...`, without the question's kind; `agents/stages/question-check.md`
repeats the rule under "Questions the maintainer has already answered on this
issue" with no distinction of kind. A capability answer therefore reads like
a decision, and nothing in the prompt says what settling means for an answer
that names an action rather than a choice.

Observed on issue #39 on 2026-11-01 (runs under `runs/`, `questions/log.jsonl`
lines 9 to 20, `escalations/39.abandoned-2026-11-01T09-03-10-729Z.json`):

- Question #6555684883, kind `capability`, asked the maintainer to restore
  command execution on the laptop: the harness refused every shell command
  with `ENOSPC`, including `df` and `true`. Its options were worded without
  saying who acts. The maintainer answered with the first option's label,
  "1. Inspect the affected volume and reclaim space from confirmed
  disposable files, then resume the fix stage" (09:01Z).
- The resumed fix run `39-fix-1-20261101T090136` was refused the same way
  and asked again. The check `39-question-check-1-20261101T090157` returned
  `decide_yourself`: "Question #6555684883 already asked the maintainer to
  restore command execution ... That settles the recovery choice now
  proposed again. I verified in 39-fix-1-20261101T090136/events.jsonl that
  the diagnostic command was still refused before execution, but this is
  persistence of the same capability failure, not a newly discovered
  limitation." The check saw that the action had not happened and judged
  the question settled anyway.
- After the escalation to the spec track, the spec run
  `39-spec-1-20261101T091550` asked the same thing; the check
  `39-question-check-1-20261101T092221` returned `decide_yourself` again,
  citing the same answer and telling the agent to "arrange recovery through
  an agent or execution path that can operate". That was the issue's second
  `decide_yourself` (spec 006 AC-14), a bound hit: the ledger shows
  `decideReturns: 2` and `specRescues: 1`, and the issue was abandoned.

Each check run had the evidence that the blocker still stood, and each held
it against the asking agent. The condition itself (a full volume) is issue
#114's, now spec 059: a run whose every shell command the host refused no
longer reaches the check. This spec is about the check's judgement, which
applies to any capability answer whose action has not happened: a token not
yet added, a runner not yet fixed, a board not yet recovered.

### The fix

Three changes, all on the question check's side.

1. **The check's input tells decisions from reported actions.** The driver
   splits the issue's answered questions by kind: product and technical
   answers stay under `answered_questions`, each with its kind; capability
   answers go under a new input, `reported_actions`, each with the time it
   was answered. The prompt renders both.
2. **The prompt has a rule for each list.** A decision that settles the
   question is `decide_yourself` citing it, as today. A reported action is
   not a decision and settles a later question only if the action was
   carried out; when the asking stage reports that the blocker named in an
   earlier capability question still stands after its answer, the check
   returns `send`, wording the question as a follow-up on that answer.
3. **A capability question names who acts.** The check's wording of a
   capability question (spec 006 AC-12, "the question as the strong-tier
   check words it") gives each option the person who carries it out and the
   reply that ends the wait.

Nothing in the chain's counting changes. A `send` spends no bound (spec 006
AC-13 pauses the issue; AC-15's rule that the second reply adds to the first
already joins the two answers for the asking stage), so once the check sends
the follow-up the exchange costs the issue nothing, which is the design's
rule for follow-ups (section 3, "What happens while it waits"). A
`decide_yourself` stays counted as spec 006 AC-14 says, capability answer or
not: the bound is what ends the loop of a stage that asks the same thing
after being told to decide, and leaving it uncounted after a capability
answer would make that loop endless. The repeat on #39 should never have
been a `decide_yourself`; the fix is at the verdict, not the count.

*(agent's call)* The split is made in the driver rather than left to the
prompt because the rule the prompt applies ("already settles the question")
is only right for decisions: giving the check one list and asking it to
apply two rules by kind is what failed on #39, where the kind was plain from
the text. A separate input makes the referent of each rule structural. The
asking stages' prompts are not changed: the check's wording is what the
maintainer reads (spec 006 AC-12), so the actor rule belongs there. No
follow-up flag is added to the check's result: a `send` already pauses the
issue without a count, and the joined replies already reach the asking
stage. Every change is cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Not counting host-refused runs, or any run, as failed attempts: spec 059.
- The `decide_yourself` bound of spec 006 AC-14 (`MAX_DECIDE_RETURNS`) and
  how `decideYourself` in `tools/scheduler/src/chain/machine.ts` counts it.
  Section 1 says why it stays.
- The follow-up rule for the asking stage (spec 006 AC-15: `follow_up` with a
  `reply_quote` that is itself a question or a request). A stage that asks
  again after a capability answer goes through the check as today; the check
  is where the repeat is judged.
- The review stage's `answered_questions` (the diff's cited answers, verified
  against the log, spec 006 AC-10): a different list built by
  `answeredQuestions`, unchanged.
- The asking stages' prompts (`plan.md`, `implement.md`, `fix.md`,
  `review.md`, `spec.md`, `design.md`), the question comment's format
  (`questionBody`), the Telegram buttons, and the questions log's entries and
  schema.
- Rewriting issue #39's ledger or records.
- The console's Questions screen (spec 051).

## 3. Acceptance criteria

"Given" states use the driver tests' fakes (`tools/scheduler/test/driver.test.ts`,
`setup` with scripted stage results and `appendQuestionLog`) and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`. A *decision* is an
`answered` entry of `questions/log.jsonl` whose logged question has kind
`product` or `technical`, or whose question is not logged (its kind is
unknown and it is listed as today); a *reported action* is one whose logged
question has kind `capability`. `oneLine` is the driver's existing
whitespace-collapsing helper.

- AC-1. **The check's input lists decisions and reported actions apart.**
  Given a question check run for an issue, when the driver builds its
  input, then `answered_questions` holds the issue's decisions, oldest
  first, one line each: `#<id> (<kind>): Question: <oneLine question>
  Answer: <oneLine answer>`, where `<kind>` is `product`, `technical` or
  `unknown`; and `reported_actions` holds the issue's reported actions,
  oldest first, one line each: `#<id> (capability, answered <at>):
  Question: <oneLine question> Answer: <oneLine answer>`, where `<at>` is
  the entry's `at`. Either list is `(none)` when empty; the two never share
  an entry; an entry of another issue appears in neither. `StageInput`
  gains `reported_actions?: string` and `renderPrompt` renders
  `{{reported_actions}}` from it, `(none)` when absent. Given a stage other
  than the question check, then its input has no `reported_actions`. The
  existing driver test for C8 is updated to the new line shape and a test
  with one answered question of each kind on the issue, plus one of another
  issue and one with no logged question, asserts both strings and that the
  rendered `prompt.md` carries both; it fails on `main` before the change.
- AC-2. **The prompt tells the check what each list settles, and how to
  word a capability question.** `agents/stages/question-check.md`:
  - keeps the `{{answered_questions}}` input and its rule ("When one of these
    already settles the question, return `decide_yourself` and cite it"),
    introduced as the issue's product and technical answers;
  - gains the `{{reported_actions}}` input under a heading of its own, with
    the rule, in these words or words that keep them: an answer to a
    capability question is not a decision (spec 006 AC-18): it reports or
    promises an action outside the agents' reach, and it settles a later
    question only if that action was carried out. When the asking stage
    reports that the blocker named in an earlier capability question still
    stands after its answer, and the check's own investigation does not show
    the blocker gone, the check returns `send`, whatever the answer said and
    whoever it named to do the work: an answer that tells agents to do what
    the earlier question said they cannot has not been carried out. The
    check never returns `decide_yourself` on the ground that a reported
    action assigned the work to agents;
  - says how to word that `send`: as a follow-up on the earlier answer,
    naming the earlier question's id, quoting the answer, stating the
    asking stage's evidence that the blocker still stands, and asking the
    maintainer to say who does the work; its options are the action done by
    the maintainer with the reply that ends the wait (such as `done`), and
    any other way out the asking stage or the check can name, each with who
    carries it out;
  - says that every capability question it words gives each option who
    carries it out (the maintainer, or agents and how) and what reply ends
    the wait.

  `tools/scheduler/test/stages.test.ts` pins the file: it contains
  `{{reported_actions}}`, the existing phrase `already settles the question,
  return \`decide_yourself\` and cite it`, the phrases `is not a decision`,
  `still stands` and `who carries it out`, and the full-input render of the
  committed prompt (the test's `full` input gains `reported_actions`)
  succeeds with no unknown placeholder.
- AC-3. **The exchange after an unfulfilled capability answer costs the
  issue nothing.** Given an issue-track chain whose implement run returns a
  capability escalation, the check sends it, the maintainer answers with an
  instruction (`reclaim space, then resume`), the resumed implement run
  returns a capability escalation again, and the check (scripted) returns
  `send` with a follow-up wording, when the maintainer answers `done` and
  the next implement run succeeds, then: after the second `send` the issue
  is paused with the check's wording and its ledger has `decideReturns` 0
  and no `decide_yourself` history entry; the second resumed implement run's
  input `answer` carries both replies, each prefixed `Question #<id>: `, in
  order; the questions log for the issue reads `asked, checked, sent,
  answered, asked, checked, sent, answered`; nothing is recorded under
  `docs/decisions/` and the chain merges as spec 006 AC-28's capability case
  does. The `answered_questions` input of the second check run is `(none)`
  and its `reported_actions` names the first question's id and the
  instruction. This is an e2e test beside "capability question from
  implement (spec 006 AC-28)"; the machine is unchanged and the test pins
  that the existing joined-reply rule (spec 006 AC-15) serves this path.
- AC-4. **The old rule is marked.** Spec 006 AC-12 carries the mark of
  section 4, and its earlier text follows unchanged.

## 4. Amendments to earlier specs

- Spec 006 AC-12 is marked `Amended by
  [062-capability-answer-settles-nothing](../062-capability-answer-settles-nothing/spec.md)
  AC-1: the check's answered questions are the issue's product and technical
  answers; capability answers are listed apart as reported actions and
  settle a question only if their action was carried out (AC-2).` The
  earlier text stays as the record.

Spec 006 AC-14, AC-15 and AC-18 are not amended: the `decide_yourself`
count, the follow-up rule and the joined replies, and the rule that a
capability answer is not a decision, apply as written. Spec 059 is not
amended: a host-refused run never reaches the check, and this spec covers
the check when a run does reach it.

## 5. Interfaces and files

- `tools/scheduler/src/stages/prompt.ts`: `StageInput.reported_actions?:
  string`; `renderPrompt` renders `reported_actions` (AC-1).
- `tools/scheduler/src/chain/driver.ts`: `issueAnswers` returns the two
  lists (decisions and reported actions) by the logged question's kind;
  `runAgentStage` passes both into the question check's input, and
  `buildInput` carries `reported_actions` (AC-1).
- `agents/stages/question-check.md`: the `{{reported_actions}}` input and
  the rules of AC-2.
- `specs/006-no-human-stops/spec.md` AC-12: the mark of section 4 (AC-4).
- Tests: `tools/scheduler/test/driver.test.ts` (AC-1),
  `tools/scheduler/test/stages.test.ts` (AC-2),
  `tools/scheduler/test/e2e.test.ts` with the scripted results it needs in
  `tools/scheduler/test/helpers/e2e-routes.ts` (AC-3).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies to the implementation PR (spec
006 AC-9). Nothing here changes the sensitive-path list, the security
criteria, what routes a sensitive diff to the security review, section 3 of
the design, or any text marked as a maintainer answer. No schema changes:
`question-check-result`, `question-log-entry` and the stage-input shape
the prompt renders from are as today, with one optional string more on the
input. No new network listener, outbound call or shell execution.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-1 driver test fails on `main` before the change (no
  `reported_actions` on the input) and passes after it. The AC-2 prompt
  test fails on `main` (no `{{reported_actions}}`) and passes after it.
- A grep of `tools/scheduler/src` shows `reported_actions` written in
  `chain/driver.ts` and read in `stages/prompt.ts` only, and
  `MAX_DECIDE_RETURNS` and `decideYourself` in `chain/machine.ts` unchanged
  against `main`.
- Live check after deploy: the next capability question answered on an
  issue is followed, on the next question check of that issue, by a
  `prompt.md` under `runs/` whose reported-actions list names that
  question's id and answer and whose answered-questions list does not.

## 7. Open decisions

None.
