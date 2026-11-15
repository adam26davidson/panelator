# 0012. An incomplete credential, funds or first-contact request is an invalid result, sent back for completion; it is never "decide it yourself"

Status: accepted
Date: 2026-11-15
Amends: [specs/030-beyond-github](../../specs/030-beyond-github/spec.md) AC-6
(an incomplete request was returned as `decide_yourself`) and
[specs/006-no-human-stops](../../specs/006-no-human-stops/spec.md) AC-12 (the
question check's verdicts) and AC-14 (decide mode)
Decided by: the spec stage of issue #129 (an agent's call on a possible design
flaw, process-spec 4.2 step 3: a technical decision about how the chain
treats a malformed question, with one clearly right answer and reversed by
one PR; delivery-system design section 3); carried by
[specs/067-incomplete-request-is-sent-back-for-completion](../../specs/067-incomplete-request-is-sent-back-for-completion/spec.md)

## Context

Design section 8 says a credential request names the exact access and gives
step-by-step setup, a funds request gives what for, the amount and the
charter goal, and a first-contact request says who, why and what would be
sent. Spec 030 AC-6 made that a `request` object on the capability question
and had the question check reject an incomplete one with `decide_yourself`.
But `decide_yourself` puts the asking stage in decide mode (spec 006 AC-14),
where it may not ask the sent-back question again in any wording, a
`new_blocker` that is the same question in other words is the issue's second
`decide_yourself` and a bound hit, and the three needs are exactly the ones
agents cannot decide for themselves (design section 3, item 3). A stage that
left out one field had no legitimate way to send the completed request
(issue #129).

## Options

1. **Exempt a request completed after a "must give <fields>" return from
   counting as the same question in decide mode.** Keeps the check's two
   verdicts, but the way back turns on the check's judgement of "same
   question" each time, still spends the issue's one free `decide_yourself`,
   and contradicts the decide-mode paragraph of every asking stage's prompt.
2. **The check completes the request itself and sends it.** The check does
   not have the asking stage's knowledge (the scopes it found it needs, the
   amount, the message it would send); the maintainer would act on a guess.
3. **An incomplete request is an invalid result, sent back for completion.**
   The chain machine checks every question's `request` in code where every
   question already passes (`ask()`), runs the asking stage again holding
   its committed work with the missing fields named in its history, outside
   decide mode and counting no `decide_yourself`; a second incomplete request
   on the claim is a failed run of the stage. For the case code cannot see,
   a question whose text asks for one of the three needs but carries no
   `request`, the check gets a third verdict, `incomplete`, that takes the
   same path.

## Decision

Option 3. Forgetting a field of a request is a malformed result, like any
result that fails its schema (spec 001 AC-22), and gets that treatment with
two refinements: the work committed before the question is held, as it is
for every question (spec 011), and the reason names the fields in the
stage's own vocabulary. Completeness is judged in the machine rather than by
`required` in the schema so that the run reaches the point where the work is
held. `decide_yourself` keeps its one meaning: the question is not one of the
maintainer's three kinds, so the agent decides it. A missing field says
nothing about whose question it is.

## Consequences

- The question check has three verdicts: `send`, `decide_yourself` and
  `incomplete`. Spec 006 AC-12 is amended; the check's prompt and result
  schema, the question log's `checked` entry and the chain machine carry the
  new value.
- The chain gains one count, `incompleteRequests`, bounded at one free
  rerun per claim; the second incomplete request follows the asking stage's
  own failure rule. The ledger and the claim schema carry it.
- The `decide_yourself` bound (`MAX_DECIDE_RETURNS`), the decide-mode rule of
  the asking stages and the check's judgement of a repeated question are
  unchanged: an incomplete request never reaches them.
- The five asking stages' prompts gain the request paragraph spec 030
  section 5 planned, in the amended form. Spec 030's own implementation, when
  issue #39 is retried, finds the `request` object and the paragraph in place
  (or adds them first if it lands first; the shape is fixed by spec 067 AC-1).
