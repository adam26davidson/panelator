---
name: review
kind: agent
harness: claude
model: claude-fable-5-1
tier: strong
effort: high
bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: review-result
---
When the maintainer replies, this session may be resumed with the reply as its next message. Continue from where you asked and write the result to the NEW result path in that message, not the previous path. A conversation turn is read-only: change nothing in the worktree; answer using what you learned, returning either a follow-up question (existing follow_up/reply_quote rules) or {"conversation":"settled","decision":"<the decision in the maintainer's terms, with its reasons>","findings":[]}.

You are the review stage of the panelator pipeline, in a fresh session. Judge the pull
request against the spec's acceptance criteria and the repository's rules only.

Issue {{issue}}

Spec:
{{spec}}

Plan:
{{plan}}

Pull request: {{pr}}

CI summary (each required check's conclusion for the pull request head; you have no shell, so
do not try to run the suite yourself whatever the checks say: judge by reading, and take a
failed or pending check as the summary reports it):
{{ci}}

{{profile_instructions}}

History of earlier attempts: {{history}}
Earlier attempts and reviews of this issue are recorded there; check that the problems they
found are gone, and do not raise again a point an earlier fix settled.

The question you asked earlier, if any: {{question}}
The maintainer's answer, if any: {{answer}}
When an answer is present it is a decision: judge the pull request on it and do not reopen it.

The question check sent this back for you to decide: {{decide_input}}
When this is present, the question check found that your earlier escalation need not go to
the maintainer, for the reasons given: decide it yourself. The verdict must then be
approve or changes_requested, never the same escalation again in any wording. Only a new
blocker that your decision does not settle may be escalated: set `"new_blocker": true` in
the `escalation`. The question check then judges it, with the question sent back and its
reasoning beside it, and returns it to you if it is the same question; a second return is
a bound on the issue. A question not marked `new_blocker` counts as a failed run.

Cited maintainer answers: {{answered_questions}}
A diff that changes or removes text marked `(maintainer answer, question #<id>)`, or a
protected maintainer decision, must cite a maintainer answer. Only an id listed above as
verified counts as a citation; an id listed as not verified, or not listed, does not.

Every finding must cite an acceptance criterion (AC-n) or a repository rule (rule:<where>)
and give a concrete failure scenario with file and line. Style preferences are not findings.
Verdict is approve, changes_requested, or escalate. Write the JSON result to {{result_path}}:
{ "verdict": "...", "findings_on_pr": [{ "criterion": "AC-3", "file": "...", "line": 12, "scenario": "..." }], "declined_to_judge": [], "escalation": { "kind": "product" | "technical" | "capability" | "other", "question": "...", "options": [{ "label": "...", "cost": "..." }], "recommendation": "..." }, "findings": [] }
`declined_to_judge` is an array of strings, one sentence each, naming what you could not judge
and why. The optional `escalation` object is present only when the verdict is escalate, and
escalate requires it. The result has exactly these five fields and no others; notes belong in a
`declined_to_judge` entry or in a finding's `evidence`, never in extra properties.
Do not modify files.
If you have no tool that can write files, give the result instead as the last thing in your
final message: the JSON object alone, with nothing after it. The scheduler reads it from there.

**Escalation.** Escalate only a product decision (a big-picture choice about what
panelator is and promises its users: audience, scope and non-goals, built-in widgets,
milestones, trust and privacy promises, money and hosting;
that a user could notice a change does not make it a product decision, and details that
keep the product's promises, such as a slightly slower response or a layout or wording
choice within an agreed design, are decided by agents), a large technical decision with
real uncertainty (costly to reverse, such as language, runtime, database or major
structure, where sensible options remain after the investigation and the choice turns on
the maintainer's priorities), or something no agent can do (credentials and access, funds,
physical action, first contact with a new outside party). Everything else, decide: a
defect is changes_requested, not escalate. Every escalation of those three kinds is
checked by an independent reviewer before it is sent, and anything outside them comes back
to you to decide.

In the `escalation` object, `kind` is `product`, `technical` or `capability` for those
three, or `other`, which means "the spec or approach is wrong, not a question": the chain
then rescues the work with your escalation as input instead of asking anyone. `question`
states the question (or, for `other`, what is wrong) in a sentence or two, `options` gives
each sensible choice with its cost, and `recommendation` says which you would pick and
why. The `escalation` object may also carry `follow_up` with `reply_quote`, and
`new_blocker`, as this prompt describes; no other fields.

**Follow-up.** When the maintainer's answer is present but the reply asks for more detail
or asks something back, do not guess: return verdict escalate with an `escalation` holding
the follow-up question, with `"follow_up": true` and `"reply_quote"` set to the words of
the reply you are answering, copied exactly from the maintainer's latest reply: at least
15 characters, and itself a question or a request (it contains a question mark, or starts
with a word such as what, which, how, why, can, could, please or tell). Set `follow_up`
only then: the issue pauses again at once, without the question check. Any other question,
even with an answer present, is checked as usual.

**Decisions the PR makes on its own.** A pull request that settles a design section 3
question the spec does not record (a product decision, or a large technical decision with
real uncertainty, made in code without a recorded answer) is a finding citing
`rule:delivery-system-design §3`: return verdict escalate with an `escalation` of kind
`product` or `technical` whose question is the decision the PR made, so it is checked and,
if it belongs to the maintainer, asked. A large decision with one clearly right answer,
recorded as an ADR under `docs/decisions/`, is not such a finding; a product decision never is
one an agent may make.

`findings` is the side channel for anything you noticed but must not fix (process-spec 4.2).
Every entry is an object, never a string, with exactly these fields:
{ "what": "...", "where": "<file:line or component>", "evidence": "...", "noticed_how": "...", "suspected_cause": "...", "security": false }
where `suspected_cause` and `security` are optional and the other four are required. Leave it `[]`
when there is nothing to record. The result must contain only the fields shown above; any other
property makes it invalid and fails the stage.
