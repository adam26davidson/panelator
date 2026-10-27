# Spec 006: The chain runs to merge with no human stops — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every `needs-human` outcome in `tools/scheduler` with these steps, run by agents:
- rescue, re-plan, spec revision, then a recorded abandonment, counted per issue in a ledger that survives a release;
- a spec stage whose changes reach `main` through their own PR, gated by its own scope check;
- a question check that decides whether a question reaches the maintainer, with a pause-and-resume over issue comments, a questions log, and answers recorded in the spec or an ADR;
- security findings through the fix loop;
- the design hierarchy's `Parent:` and `Children` links, checked in `pnpm test`.

**Architecture:** The chain stays a pure state machine (`chain/machine.ts`). Escalation is one function, `escalate()`, that every exhausted bound calls, and its limits are constants in that module. Actions carry every value the driver needs from the state before the transition (the driver applies actions after the new state is set). The spec PR reuses the existing verify, review, fix and merge stages, with a `track: "spec"` flag on `ChainState` and its own branch, `spec-<issue>`, which the scheduler prepares. Every transition into the spec stage sets `track: "spec"`, so `branchOf(state)` alone names the branch for the spec stage, a question check it asks, and its PR. A paused issue has no claim: its state lives in `paused/<issue>.json`, and the service loop resumes it when the maintainer comments, by writing a claim that holds the `answered` event for the driver to apply. Escalation counts and history are mirrored to `escalations/<issue>.json`, so a re-claim starts where the last chain stopped. Two crash windows are closed with markers on the claim: `pendingEvent` (a resume not yet applied) and `pendingActions` (an abandonment not yet finished).

**The chain's transitions are spec 006 section 4.** That table is the single source. Tasks 5 and 6 name the rows they implement and state only what the table leaves out: the state fields each row sets, the action lists, and the helpers.

**Tech Stack:** Node 26 (native `.ts`, `erasableSyntaxOnly`), TypeScript 7 typecheck, vitest 3, ajv 8, yaml 2, octokit, all as already used by `tools/scheduler`.

**Spec:** `specs/006-no-human-stops/spec.md` (AC-n below are its criteria). It amends `specs/001-scheduler-core/spec.md`; read section 4 of spec 006 for the chain table and the valid-event list this plan implements. The design behind it is `docs/delivery-system-design.md`.

## Global Constraints

- `pnpm test` from the repo root passes and `pnpm -F @panelator/scheduler typecheck` is clean before any task is called done; include the test output in the final message (AGENTS.md). Every task's verification step runs both.
- Work on branch `spec-006-impl` cut from `main`. Commit per task; do not push (AGENTS.md).
- TypeScript ESM, `erasableSyntaxOnly`: no `enum`, no parameter properties, no namespaces. Relative imports carry `.ts`.
- No test touches the network. GitHub is `test/helpers/mock-github.ts`; harnesses are fake adapters as in `test/driver.test.ts`.
- Escalation bounds are constants in `src/chain/machine.ts`, never config or stage definitions (AC-6): `MAX_RESCUES = 1` (applied per track), `MAX_REPLANS = 1`, `MAX_SPEC_REVISIONS = 1`, `MAX_SPEC_ANSWERS = 1`, `MAX_DECIDE_RETURNS = 1`, `VERIFY_PENDING_MAX_H = 6`. History: `HISTORY_ENTRY_MAX = 4000` characters per entry, `HISTORY_MAX_ENTRIES = 20`. `MAX_FIXES = 2` stays in `gates/fix-loop.ts`, unchanged.
- Old exports stay until the task that removes their last use: `NEEDS_HUMAN` and `NEEDS_CLARIFICATION` until Task 5, `SECURITY_REVIEW_LABEL` until Task 5, `NEEDS_SPEC` until Task 9.
- Label names: `needs-decision` (paused, AC-13), `abandoned` (AC-5; the issue stays open), `needs-design-stage` (AC-20). `needs-human`, `needs-spec`, `needs-clarification`, `needs-design` and `security-review` are no longer applied by any code path.
- Branches: issue PRs stay `issue-<issue>`. Spec PRs use `spec-<issue>`; the scheduler creates it from `origin/main` before the spec stage and deletes it locally and on GitHub after a spec-track merge, when its PR is closed, or when a claim on the spec track is released, so the name is free for the next spec PR. The spec prompt never creates or switches branches. Spec PR bodies say `Refs #<issue>`, never a closing keyword.
- Question comment heading, exact: `### Question for the maintainer`, followed by `@<maintainer>` from `agents/scheduler.yaml`; its last line is `<!-- panelator-question:<nonce> -->` with the paused record's nonce. Reminder after 24 hours, exactly once, as a comment and a notification (AC-16). The abandonment comment never @-mentions anyone (AC-5).
- Recorded-answer mark, exact: `(maintainer answer, question #<question comment id>)` (AC-18). The citation check matches `/question #(\d+)/` in the diff's added lines.
- The product-decision rule, wherever a prompt or criterion paraphrases design section 3 item 1, uses the narrowed text: big-picture choices about what panelator is and promises its users (audience, scope and non-goals, built-in widgets, milestones, trust and privacy promises, money and hosting); that a user could notice a change does not make it a product decision, and details that keep the product's promises (a slightly slower response, a layout or wording choice within an agreed design) are decided by agents.
- Model ids: rescue model `claude-fable-5-1`; question check primary `openai/gpt-6.1-sol` on pi, fallback `claude-fable-5-1`; spec stage `claude-fable-5-1`.
- `docs/charter.md` must never appear in this branch's diff (the spec does not list it, and the scope rule keeps it out).

## Review Focus

1. **A maintainer comment written before the question.** If the maintainer had commented earlier in the issue, that comment must not resume it. Only comments with an id above `question_comment_id` and a GitHub creation time after `asked_at` count; both come from GitHub's response to the question comment, never the local clock. Pinned in Task 7.
2. **A spec PR that edits its parent design outside the `## Children` section, or names the charter as its parent.** Both must be scope violations, even though the parent file is otherwise allowed. Pinned in Task 4.
3. **A review result with `verdict: "escalate"` and no `escalation` object.** It must fail schema validation, so the stage is recorded as a failed run (and retried), not a crash in the machine. Pinned in Task 1.
4. **A spec stage result whose `spec_path` points outside `specs/`** (`../x`, `specs/../docs/charter.md`). The result must be refused as a failed run, and the issue body must not be edited. Pinned in Task 8.
5. **A paused issue that the maintainer closes instead of answering.** Its `paused/` record must be dropped on the next tick and never resumed. Pinned in Task 9.
6. **`close_pr` after the state has dropped the PR.** The driver applies actions after the new state (with `pr: null`) is set, so the action itself must carry the PR number and branch. Pinned in Tasks 5 and 8.
7. **The first implement after a spec PR merges.** It must push `issue-<issue>`, not `spec-<issue>`. Pinned in Tasks 8 and 10.
8. **A crash in the middle of a pause or a resume.** It must not post a second question comment, adopt an earlier question's comment, claim the issue twice, drop the `answered` transition's actions, or leave it with neither a claim nor a paused record. Pinned in Tasks 8 and 9.
9. **A plan result holding only an `escalation`.** It must validate (the `spec_gap` rule must not fire without a verdict) and must not be failed by the domain-profile check. Pinned in Tasks 1 and 8.
10. **A citation of a maintainer answer that does not exist.** The review input must list it as unverified, so the security review does not accept it. Pinned in Task 8.
11. **A crash in the middle of an abandonment.** The next tick finishes it without a second comment, finding or notification. Pinned in Task 8.
12. **The spec stage's own branch.** The spec stage, entered from any route, runs on `spec-<issue>`, never `issue-<issue>`. Pinned in Tasks 6 and 8.

## File structure

```
tools/scheduler/src/
  types.ts                  + SpecMode, Question, AskingStage, SpecResult, QuestionCheckResult; escalation on plan/implement/fix/review results; AgentStageName + "spec" | "question-check" (Task 2); StageDefinition.independent
  stages/prompt.ts          + history, question, answer, mode, decide_input, spec_problem, answered_questions placeholders
  stages/definition.ts      stage names, `independent`
  runner/retry.ts           independent fallback, postpone after a rate-limited fallback
  runner/worktree.ts        + checkoutBranch(), deleteLocalBranch()
  config.ts                 + rescue_model
  spec/parse.ts             + parent, parseChildren()
  gates/design-tree.ts      NEW: checkDesignTree(), loadDesignTree()
  gates/spec-present.ts     parent checks (Task 4); ignore-kind failures (Task 9)
  gates/spec-scope.ts       NEW: specScopeGate()
  gates/scope.ts            + extra allowed prefixes
  gates/ui-design.ts        needs-design-stage
  gates/ready.ts, fix-loop.ts   no labels (Task 5)
  gates/automation-change.ts    DELETED
  shortlist/select.ts       no automation gate, `abandoned` skip (Task 4); spec-start eligibility (Task 9)
  chain/types.ts, machine.ts    new stages, escalate(), spec track, question flow, normalizeChainState()
  chain/driver.ts           new actions, rescue model, branches, spec track, post-merge gates, citation check, pending event and actions, ledger, questions log
  github/client.ts, types.ts    + listComments, issueComment, comment() returns id, closePullRequest, deleteBranch, setIssueBody, PR body, rerequestCheckRun
  state/paused.ts           NEW: paused records, pausedDecision()
  state/ledger.ts           NEW: escalation ledger
  state/questions.ts        NEW: questions log
  state/claims.ts           normalize on read
  state/paths.ts            + paused, escalations, questions
  service/loop.ts           resume paused, reminders, spec-start claims, ledger seeding
tools/scheduler/test/       chain, gates, shortlist, driver, loop, e2e, schema, stages, retry, spec, worktree, state, client, design-tree (NEW), paused (NEW)
agents/stages/spec.md, question-check.md       NEW
agents/stages/plan.md, implement.md, fix.md, review.md   new inputs and the escalation object
agents/profiles/spec/                          NEW
agents/profiles/security/                      charter and top-design rules, fix-loop wording
agents/sensitive-paths.txt, agents/scheduler.yaml
schemas/scheduler/          question, spec-result, question-check-result, paused, escalation-ledger, question-log-entry NEW; review-result, plan-result, implement-result, fix-result, stage-input, usage-record (Task 2), claim amended
specs/00{1..6}-*/spec.md, specs/README.md, docs/process-spec.md, docs/product-spec.md, docs/delivery-system-design.md
```

---

### Task 1: Result shapes, schemas and prompt placeholders

**Files:**
- Modify: `tools/scheduler/src/types.ts`, `tools/scheduler/src/stages/prompt.ts`
- Create: `schemas/scheduler/question.json`, `spec-result.json`, `question-check-result.json`, `paused.json`, `escalation-ledger.json`, `question-log-entry.json`
- Modify: `schemas/scheduler/review-result.json`, `plan-result.json`, `implement-result.json`, `fix-result.json`, `stage-input.json`
- Test: `tools/scheduler/test/schema.test.ts`, `tools/scheduler/test/stages.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`; `AgentStageName` itself is widened in Task 2, with the definitions that need it):
  ```ts
  export type SpecMode = "write" | "answer" | "revise" | "decide" | "record";
  export type AskingStage = "plan" | "implement" | "review" | "fix" | "spec" | "verify";
  export interface Question { kind: "product" | "technical" | "capability" | "other"; question: string; options: { label: string; cost: string }[]; recommendation: string }
  export interface SpecResult { verdict: "revised" | "question"; spec_path?: string; pr_number?: number; head_sha?: string; question?: Question; findings?: Finding[] }
  export interface QuestionCheckResult { verdict: "send" | "decide_yourself"; reasoning: string; findings?: Finding[] }
  // ReviewResult, PlanResult, ImplementResult, FixResult gain: escalation?: Question
  ```
- Produces (in `src/stages/prompt.ts`): `StageInput` gains optional `history?: string; question?: string; answer?: string; mode?: SpecMode; decide_input?: string; spec_problem?: string; answered_questions?: string`. `renderPrompt` maps `{{history}} {{question}} {{answer}} {{mode}} {{decide_input}} {{spec_problem}} {{answered_questions}}`; each renders `(none)` when absent.
- Schema names for `validate(name, data)`: `question`, `spec-result`, `question-check-result`, `paused`, `escalation-ledger`, `question-log-entry`.

- [ ] **Step 1: Write the failing tests** in `test/schema.test.ts`:

```ts
const q = { kind: "technical", question: "WAMR or wasm3?", options: [{ label: "WAMR", cost: "keeps AOT" }, { label: "wasm3", cost: "slower" }], recommendation: "WAMR" };
it("review escalate requires an escalation object (AC-8, review focus 3)", () => {
  expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(false);
  expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [], escalation: q }).ok).toBe(true);
  expect(validate("review-result", { verdict: "approve", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(true);
});
it("spec-result: revised needs spec_path, pr_number, head_sha; question needs question (AC-21)", () => { /* as the four cases below */ });
it("question-check-result is send or decide_yourself with reasoning (AC-12)", () => { /* send ok; maybe fails; missing reasoning fails */ });
it("question options need label and cost", () => expect(validate("question", { ...q, options: [{ label: "x" }] }).ok).toBe(false));
it("plan, implement and fix results may carry an escalation instead of their fields, never of kind other (AC-17)", () => {
  expect(validate("implement-result", { escalation: { ...q, kind: "capability" } }).ok).toBe(true);
  expect(validate("implement-result", { escalation: { ...q, kind: "other" } }).ok).toBe(false);
  expect(validate("implement-result", { tasks_done: [] }).ok).toBe(false);
});
it("a plan result holding only an escalation validates; spec_gap still needs questions (AC-17, review focus 9)", () => {
  expect(validate("plan-result", { escalation: q }).ok).toBe(true);
  expect(validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [] }).ok).toBe(false);
});
```

Also: `spec-result` revised with all three fields passes and without `spec_path` fails; `paused` requires `phase`, `nonce`, `question_comment_id` and `asked_at` (the last two nullable); `escalation-ledger` round-trips a full record; `question-log-entry` accepts `question_comment_id` and `reply_comment_id`. In `test/stages.test.ts`: `renderPrompt("{{mode}}|{{history}}|{{answer}}", { ...minimalInput, mode: "revise", history: "h" })` returns `"revise|h|(none)"`.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/schema.test.ts tools/scheduler/test/stages.test.ts`. Expected: FAIL (unknown schemas, unknown placeholder).

- [ ] **Step 3: Implement.**
  - **`spec-result`** uses `if/then`: `revised` requires `spec_path` (pattern `^specs/[0-9]{3}-[a-z0-9-]+/spec\.md$`), `pr_number` and `head_sha` (40 hex); `question` requires `question` (`$ref: question.json`).
  - **`review-result`** gains `escalation` and `if verdict=escalate then required [escalation]`.
  - **`plan-result`, `implement-result`, `fix-result`** gain `escalation` (`$ref` with `kind` not `other`). `oneOf`: either the existing required fields, or `escalation` alone (plus optional `findings`). The top-level `required` moves into the first branch. In `plan-result`, the `spec_gap` rule moves into the first branch too, so it never applies to an escalation-only result (an `if` on `verdict` passes vacuously when `verdict` is absent).
  - **`stage-input`** gains the seven optional fields; `mode` takes the `SpecMode` enum.
  - **`paused`** describes the Task 7 record. **`escalation-ledger`** and **`question-log-entry`** describe the Task 7 ledger and log lines.
  - **Loading.** Check how `src/schema/validate.ts` loads the schema directory; if it lists file names, add the new ones.

- [ ] **Step 4: Run** the same command, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.

- [ ] **Step 5: Commit** `scheduler: result shapes for the spec stage, question check and escalations (spec 006 AC-8, AC-12, AC-17, AC-21)`.

---

### Task 2: Stage definitions, stage prompts, independent fallback, rescue model, profiles

**Files:**
- Modify: `tools/scheduler/src/types.ts` (`AgentStageName`), `tools/scheduler/src/stages/definition.ts`, `tools/scheduler/src/runner/retry.ts`, `tools/scheduler/src/config.ts`
- Create: `agents/stages/spec.md`, `agents/stages/question-check.md`, `agents/profiles/spec/profile.yaml`, `agents/profiles/spec/instructions.md`, `agents/profiles/spec/review-criteria.md`
- Modify: `agents/stages/plan.md`, `agents/stages/implement.md`, `agents/stages/fix.md`, `agents/stages/review.md`, `agents/scheduler.yaml`, `schemas/scheduler/usage-record.json`
- Create: `tools/scheduler/test/fixtures/streams/pi-429.jsonl`
- Test: `tools/scheduler/test/stages.test.ts`, `retry.test.ts`, `config.test.ts`, `profiles.test.ts`, `adapters-pi.test.ts`, `schema.test.ts`

**Interfaces:**
- Consumes: `SpecMode`, `Question` from Task 1.
- Produces:
  - `AgentStageName` gains `"spec" | "question-check"`; `STAGES` gains both, and `loadStageDefinitions(dir)` requires all six. Test fixtures typed `Record<AgentStageName, StageDefinition>` gain the two entries in the same commit.
  - `usage-record.json`'s `stage` enum gains `spec` and `question-check` in the same commit, because `writeUsageRecord` validates against it and throws on an unknown stage.
  - `StageDefinition.independent?: boolean`.
  - `Config.rescue_model: string`, default `"claude-fable-5-1"`.
  - `retryDecision(def, judgement, costSoFar, limit)`: for `def.independent && def.fallback` on API status 429, `{ kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) }`, regardless of tier and cost (AC-26).
  - `afterFallback(def, judgement): { kind: "postpone" } | { kind: "none" }`: `postpone` when the fallback run's judgement is a 429 and `def.tier === "strong"`, so a rate-limited fallback of the question check postpones instead of failing (AC-26). Task 8's driver calls it after the fallback run.

- [ ] **Step 1: Write the failing tests.**
  - `stages.test.ts`:
    - `parseStageDefinition` accepts a strong-tier stage with `fallback` when `independent: true`, and still throws `/may not name a fallback/` without it;
    - `loadStageDefinitions(agentsDir)` returns keys `plan implement review fix spec question-check`;
    - `defs["question-check"]` has `harness: "pi"`, `model: "openai/gpt-6.1-sol"`, `independent: true`, `fallback: "claude-fable-5-1"`, `input: "stage-input"`;
    - `defs.spec` has `tier: "strong"`, `profile: "spec"`, `output: "spec-result"`, no `fallback`;
    - **the real stage prompts carry the new inputs** (AC-1, AC-14, AC-15, AC-17): read `agents/stages/{plan,implement,fix,review}.md` from disk and assert each contains `{{history}}`, `{{answer}}` and `{{decide_input}}`, describes `escalation`, and matches `/follow-up/`; each, and `question-check.md`, matches `/that a user could notice a change does not make it a product decision/i` and does not match `/a user would notice/i`; `review.md` names all five result fields and contains `{{answered_questions}}`; `plan.md` does not match `/for the maintainer/`; `spec.md` contains `Refs #`, `(maintainer answer, question #` and `docs/product-spec.md`, and does not match `/git (checkout|switch|branch)/`; `question-check.md` matches `/recorded maintainer decision.*always.*send/s`. Rendering each real file with a full `StageInput` does not throw.
  - `retry.test.ts`: an independent strong def with a 429 judgement and `costSoFar` 99 returns the fallback; a non-independent strong def returns `postpone`, as today; `afterFallback` returns `postpone` for a strong def's 429 and `none` for a non-429 failure.
  - `schema.test.ts`: `validate("usage-record", …)` accepts `stage: "spec"` and `stage: "question-check"`, and still rejects `stage: "nope"`.
  - `adapters-pi.test.ts`: the new `pi-429.jsonl` fixture is judged `failed` with `apiErrorStatus: 429` (build it from `pi-error-exit0.jsonl`, with the error text the regex at `src/adapters/pi.ts:66` reads).
  - `config.test.ts`: `rescue_model` is `"claude-fable-5-1"` from the default config and when the key is absent.
  - `profiles.test.ts`: `resolveProfile(agentsDir, "spec")` resolves, with non-empty `reviewCriteria` that matches `/maintainer answer, question #/`.

- [ ] **Step 2: Run** these test files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`definition.ts` and `retry.ts`.** `independent` is parsed as a boolean. The strong-tier fallback check becomes `fallback && tier === "strong" && !independent`. `retryDecision` checks `independent` before the strong-tier postpone. `afterFallback` as above.
  - **`agents/stages/spec.md`.**
    - Frontmatter: `name: spec`, `kind: agent`, `harness: claude`, `model: claude-fable-5-1`, `independent: false`, `tier: strong`, `effort: high`, `bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }`, `permission: no-prompt`, `worktree: issue`, `profile: spec`, `input: stage-input`, `output: spec-result`. No `fallback`.
    - The prompt states each mode (`{{mode}}`):
      - `write`: write or complete the spec named by `{{spec_problem}}`;
      - `answer`: answer the plan's questions in `{{spec_problem}}`, writing technical answers into the spec marked as the agent's call;
      - `revise`: change the spec so the history `{{history}}` stops failing;
      - `decide`: the check returned `{{decide_input}}`, so pick an approach and write it in;
      - `record`: write the maintainer's answer `{{answer}}` to `{{question}}` where it belongs (AC-18): a product answer into `docs/product-spec.md` or the top design it belongs to; a technical answer into the spec, or into an ADR under `docs/decisions/` for a large technical decision.
    - It also gives:
      - the section 3 rule, quoted from the design with the narrowed product-decision text of the global constraints: only product, uncertain large technical, or capability questions may be returned as `question`;
      - the marking rule: every recorded answer carries `(maintainer answer, question #<id>)`, with the id given in `{{answer}}`; text already carrying such a mark is never changed or removed without a newer answer;
      - the follow-up rule: with `{{answer}}` present, if the reply asks for more detail or asks something back, return `question` with the follow-up instead of guessing;
      - the branch rule: the worktree is already on `spec-<issue>`; commit there and push it; do not create or switch branches;
      - the allowed files: the spec's directory, `docs/designs/`, `docs/decisions/`, the `## Children` section of the parent design (a top design or a file under `docs/designs/`, never the charter), and, only when recording a product answer, the top designs;
      - the field set, including `Parent:`;
      - open the PR into `main` with `gh`, its body starting `Refs #<issue>`, never `Closes`, `Fixes` or `Resolves`;
      - write the result to `{{result_path}}`, using the exact JSON shape.
  - **`agents/stages/question-check.md`.**
    - Frontmatter: `name: question-check`, `kind: agent`, `harness: pi`, `model: openai/gpt-6.1-sol`, `fallback: claude-fable-5-1`, `independent: true`, `tier: strong`, `effort: high`, `bounds: { timeout_min: 15, max_turns: 40, max_cost_usd: 2 }`, `permission: no-prompt`, `worktree: issue`, `profile: none`, `input: stage-input`, `output: question-check-result`.
    - The prompt quotes design section 3 in full as it now stands (the three kinds, the narrowed product-decision rule, "large" and "real uncertainty"), and design section 5's list of the maintainer's recorded decisions, then `{{question}}`, `{{spec}}` and `{{history}}`. It asks for `send` only when the question is one of the three kinds and the agent's own investigation could not settle it, and always `send` for a request to change a recorded maintainer decision; `decide_yourself` otherwise, with `reasoning` the asking agent can act on.
  - **The four existing stage prompts:**
    - all four gain `History of earlier attempts: {{history}}`, `The maintainer's answer, if any: {{answer}}` and `The question check sent this back for you to decide: {{decide_input}}`, with one line each on what to do with it;
    - all four describe the optional `escalation` object (`kind`, `question`, `options` each with `label` and `cost`, `recommendation`) and the design section 3 rule in three sentences: escalate only a product decision (a big-picture choice about what panelator is and promises its users; that a user could notice a change does not make it a product decision), a large technical decision with real uncertainty, or something no agent can do (credentials, funds, physical action); everything else, decide. Plan, implement and fix may return a result holding only `escalation` (and `findings`); with `{{decide_input}}` set they must not escalate;
    - all four state the follow-up rule: with `{{answer}}` set, a reply that asks for more detail or asks something back is answered by returning an `escalation` holding the follow-up question;
    - `review.md`: `escalate` requires the `escalation` object, where kind `other` means "the spec or approach is wrong, not a question"; "exactly these four fields" becomes five; `Cited maintainer answers: {{answered_questions}}`, with the rule that only an id listed as verified counts as a citation;
    - `fix.md`: when asked to record an answer as an ADR, the ADR carries the mark;
    - `plan.md`: "list precise questions for the maintainer" becomes "list precise questions; the spec stage answers them".
  - **`agents/profiles/spec/`.** Mirror `profiles/security/`. `tools: [Read, Glob, Grep, Bash, Edit, Write]`. `review-criteria.md` has the AC-21 rules, numbered:
    1. fits the parent design;
    2. fits the issue body;
    3. has the spec field set and a `Parent:` line, and the parent lists it;
    4. decides no section 3 question itself;
    5. edits nothing outside the allowed paths;
    6. changes or removes no text marked `(maintainer answer, question #<id>)` unless it cites an id that the review input's cited-answers list marks verified and that is newer than the marked one (AC-10, AC-18).
  - **`agents/scheduler.yaml`.** Add `rescue_model: claude-fable-5-1`.

- [ ] **Step 4: Run** the test files, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean. Where `driver.ts` switches over `AgentStageName`, add a `default: throw new Error("spec 006 Task 8")` arm; nothing reaches it until the machine emits the new stages.

- [ ] **Step 5: Commit** `scheduler: spec and question-check stages, history and escalation in every stage prompt, independent fallback, rescue model (spec 006 AC-1, AC-12, AC-14, AC-15, AC-17, AC-21, AC-26)`.

---

### Task 3: Parent and Children links and the design-tree check

**Files:**
- Modify: `tools/scheduler/src/spec/parse.ts`
- Create: `tools/scheduler/src/gates/design-tree.ts`, `tools/scheduler/test/design-tree.test.ts`
- Modify (content): `specs/001-scheduler-core/spec.md` … `specs/005-*/spec.md` (add `Parent:`), `docs/delivery-system-design.md` (add `Parent:` and `## Children`), `docs/product-spec.md` (add `Parent:` and an empty `## Children`)
- Test: `tools/scheduler/test/spec.test.ts`

**Interfaces:**
- Produces:
  - `ParsedSpec.parent: string | null`, from a line `^Parent:\s*(\S+)$` anywhere in the status block. Its absence is not added to `missing`; the gate (Task 4) owns that.
  - `parseChildren(text: string): string[] | null`: the backticked or bare repo-relative paths on `- ` bullet lines under a `## Children` heading (numbered or not, same matching as other headings); `null` when the heading is absent, `[]` when empty.
  - `checkDesignTree(files: Map<string, string>): string[]`: error strings, empty when valid.
  - `loadDesignTree(root: string): Map<string, string>`: reads the charter, `docs/product-spec.md`, `docs/delivery-system-design.md`, `docs/designs/*.md` and `specs/*/spec.md` under `root`.
  - Constants: `ROOT = "docs/charter.md"`, `TOP_DESIGNS = ["docs/product-spec.md", "docs/delivery-system-design.md"]` (Task 4's spec-scope gate reuses both).

Rules `checkDesignTree` enforces (AC-24):
- every file except `ROOT` has a `Parent:` that is a key of `files`;
- every file whose parent is not `ROOT` is listed in its parent's `Children`;
- every `Children` entry is a key of `files` and names this file as its parent;
- no cycle (follow `Parent:` from each file; reaching a file twice is a cycle);
- files under `docs/designs/` have at least two children;
- `ROOT` has no `Children` section.

- [ ] **Step 1: Write the failing tests** in `test/design-tree.test.ts`:

```ts
const tree = (o: Record<string, string>) => new Map(Object.entries(o));
const ok = {
  "docs/charter.md": "# Charter\n",
  "docs/delivery-system-design.md": "Parent: docs/charter.md\n## Children\n- `docs/designs/console.md`\n",
  "docs/product-spec.md": "Parent: docs/charter.md\n## Children\n",
  "docs/designs/console.md": "Parent: docs/delivery-system-design.md\n## Children\n- `specs/010-a/spec.md`\n- `specs/011-b/spec.md`\n",
  "specs/010-a/spec.md": "Parent: docs/designs/console.md\n",
  "specs/011-b/spec.md": "Parent: docs/designs/console.md\n",
};
it("accepts a valid tree", () => expect(checkDesignTree(tree(ok))).toEqual([]));
it("flags a dangling parent", () => expect(checkDesignTree(tree({ ...ok, "specs/011-b/spec.md": "Parent: docs/designs/nope.md\n" })).join()).toMatch(/specs\/011-b\/spec.md.*docs\/designs\/nope.md/));
it("flags a child its parent does not list", () => expect(checkDesignTree(tree({ ...ok, "specs/012-c/spec.md": "Parent: docs/designs/console.md\n" })).join()).toMatch(/not listed/));
it("flags a listed child that names another parent", () => { /* console lists 011-b whose Parent is product-spec */ });
it("flags a sub-design with one child", () => { /* console lists only 010-a */ });
it("flags a cycle", () => { /* two designs in docs/designs naming each other as parent */ });
it("exempts top designs from the two-children rule", () => expect(checkDesignTree(tree(ok))).toEqual([]));
it("the repository's own tree is valid (AC-24, AC-25)", () => expect(checkDesignTree(loadDesignTree(repoRoot))).toEqual([]));
```

In `test/spec.test.ts`: `parseSpec("Status: x\nParent: docs/a.md\n...").parent === "docs/a.md"`; `parseChildren` returns both paths of a backticked and a bare bullet, and `null` without the heading.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/design-tree.test.ts tools/scheduler/test/spec.test.ts`. Expected: FAIL. The repo test fails because no `Parent:` lines exist yet.

- [ ] **Step 3: Implement** the `parse.ts` additions and `design-tree.ts`. Error strings name the file and the rule, for example `specs/011-b/spec.md: parent docs/designs/nope.md does not exist`.

- [ ] **Step 4: Edit the documents (AC-25).**
  - **Specs.** Add `Parent: docs/delivery-system-design.md` after the `Class:` line in specs 001 to 005. Spec 006 already has it.
  - **`docs/delivery-system-design.md`.** Add `Parent: docs/charter.md` to the status paragraph as its own line. Append a final `## Children` section listing the six spec paths.
  - **`docs/product-spec.md`.** Add `Parent: docs/charter.md` as its own line under the status, and an empty `## Children` section at the end.

- [ ] **Step 5: Run** the tests again, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.

- [ ] **Step 6: Commit** `scheduler: Parent and Children links with a design-tree check over the repository (spec 006 AC-24, AC-25)`.

---

### Task 4: Gates, sensitive paths and shortlist skips

**Files:**
- Modify: `tools/scheduler/src/gates/spec-present.ts`, `ui-design.ts`, `scope.ts`, `index.ts`
- Delete: `tools/scheduler/src/gates/automation-change.ts`
- Create: `tools/scheduler/src/gates/spec-scope.ts`
- Modify: `tools/scheduler/src/shortlist/select.ts`, `tools/scheduler/src/shortlist/fetch.ts`
- Modify (content): `agents/sensitive-paths.txt`, `agents/profiles/security/review-criteria.md`, `agents/profiles/security/instructions.md`
- Modify: `tools/scheduler/test/fixtures/specs/good-backend.md`, `good-webui.md` (add `Parent: docs/top.md`)
- Test: `tools/scheduler/test/gates.test.ts`, `shortlist.test.ts`, `profiles.test.ts`

**Interfaces:**
- Consumes: `parseSpec().parent`, `parseChildren()`, `ROOT`, `TOP_DESIGNS` (Task 3).
- Produces:
  - `specPresentGate(issue: IssueData, specText: string | null, readRepoFile: (path: string) => string | null): GateResult`. Parent checks (AC-23): there is a `Parent:` line; `readRepoFile(parent) !== null`; `parseChildren(parentText)` includes the spec path. Failures still return `label(NEEDS_SPEC, reason)` in this task; Task 9 turns them into spec-stage starts, together with the loop change that uses them.
  - `uiDesignGate(...)`: labels `NEEDS_DESIGN_STAGE = "needs-design-stage"`. The reason is `"spec E will provide the design stage: " + problems`.
  - `scopeGate(diffFiles, plan, spec, sensitiveGlobs, extraAllowed: string[] = [])`: `extraAllowed` prefixes are allowed like plan scope (Task 8 passes `["docs/decisions/"]` to a fix that records an answer, AC-18).
  - `specScopeGate(diffFiles: string[], specPath: string, parentPath: string | null, parentBefore: string, parentAfter: string, recordsProductAnswer = false): ScopeResult`. Allowed files:
    - anything under `dirname(specPath) + "/"`, `docs/designs/` or `docs/decisions/`;
    - `parentPath`, only when it is in `TOP_DESIGNS` or under `docs/designs/`, and `stripChildren(parentBefore) === stripChildren(parentAfter)` (the text with the `## Children` section removed);
    - with `recordsProductAnswer`, any file in `TOP_DESIGNS`, in full (AC-21; they are sensitive, so the security review checks the citation).

    A `parentPath` that is `ROOT`, or any other file, makes every edit to it a violation (`<path>: not a design`). The charter is never allowed, whatever the flag.
  - `SelectContext.readSpec` is reused as `readRepoFile`.
  - `selectEligible(...)`: the automation-change step is removed; issues labelled `abandoned` are skipped. Its return type is unchanged in this task.

- [ ] **Step 1: Write the failing tests** in `test/gates.test.ts` and `test/shortlist.test.ts`.
  - **Spec-present.** Fails, with reasons matching `/Parent/`, for a spec without a `Parent:` line, for a parent absent from `read`, and for a parent whose Children omit the spec. Passes when the parent lists it.
  - **UI design.** `uiDesignGate(webuiSpec, [])` gives `{ ok: false, action: "label", label: "needs-design-stage" }`.
  - **Spec scope** (review focus 2):
    - `["specs/010-x/spec.md", "docs/designs/a.md", "docs/decisions/0007-x.md", "docs/top.md"]` passes when `docs/top.md` is in a test `TOP_DESIGNS` and changed only under `## Children`;
    - the same diff fails with `docs/top.md: changes outside its Children section` when a line above Children changed;
    - a `parentPath` of `docs/charter.md` with a Children-only change fails;
    - `["docs/charter.md"]` and `["tools/scheduler/src/x.ts"]` fail;
    - a top design changed above its Children section fails without `recordsProductAnswer` and passes with it; `["docs/charter.md"]` still fails with it.
  - **Scope extra.** `scopeGate(["docs/decisions/0007-x.md"], plan, spec, globs, ["docs/decisions/"])` passes; without the extra it fails.
  - **Sensitive paths and security criteria (AC-10).**
    - `readSensitiveGlobs(agentsDir)` contains `docs/charter.md`, `docs/product-spec.md`, `docs/delivery-system-design.md` and `docs/design-tree.md`, and `isSensitive` flags each;
    - `review-criteria.md` matches `/docs\/charter\.md/` and `/revert/`; it names both top designs and `docs/design-tree.md`; it matches `/author's call/`, `/section 11/`, `/section 12/` and `/Children/` (the unprotected parts), `/maintainer answer, question #/` and `/verified/`; it has a criterion matching `/sensitive-paths\.txt/` that makes removing these entries or weakening these rules a finding;
    - `instructions.md` no longer matches `/until the maintainer looks/`.
  - **Shortlist.**
    - A bot-authored validated issue whose spec lists `tools/scheduler/` is eligible (AC-11).
    - Issues labelled `needs-decision`, `needs-design-stage` or `abandoned` are skipped.
  - **Old tests.** Delete the automation-change gate's tests.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/gates.test.ts tools/scheduler/test/shortlist.test.ts tools/scheduler/test/profiles.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the gate and select changes.
  - **Content files.**
    - `agents/sensitive-paths.txt`: add `docs/charter.md`, `docs/product-spec.md`, `docs/delivery-system-design.md` and `docs/design-tree.md`, each on its own line, under a comment `# the charter and the maintainer's recorded decisions (spec 006 AC-10)`.
    - `review-criteria.md`, new numbered criteria, worded as design section 5:
      - "Any change to `docs/charter.md` is a finding. The scenario is the edit itself, and the fix is to revert it; only the maintainer changes the charter."
      - "The maintainer's recorded decisions are protected: in `docs/delivery-system-design.md`, every statement not marked *(author's call)*, including all of section 3; in `docs/product-spec.md`, every recorded product decision; in `docs/design-tree.md`, every decision entry. Changing, removing or adding one is a finding unless the PR cites `(maintainer answer, question #<id>)` with an id that the review input's cited-answers list marks verified, and carries that answer out. Statements marked *(author's call)*, the delivery design's section 11 table and section 12, and the `## Children` sections are not protected."
      - "Text anywhere marked `(maintainer answer, question #<id>)` is changed or removed only by a PR citing a verified answer with a newer id; otherwise it is a finding."
      - "Removing any of these four paths from `agents/sensitive-paths.txt`, or removing or weakening the criteria above, is a finding."
    - `instructions.md`: "Any finding blocks merge until the maintainer looks" becomes "Any finding sends the change back to the fix loop".
  - **Fixtures and helpers.**
    - Add `Parent: docs/top.md` to `good-backend.md` and `good-webui.md`.
    - Wherever tests build a repo or `readSpec` from those fixtures (`test/shortlist.test.ts`, `test/loop.test.ts`, `test/e2e.test.ts`, `test/driver.test.ts`), add `docs/top.md` with `## Children` listing the fixture's spec path. Make one helper, `withTopDesign(files, specPath)` in `test/helpers/repo-pair.ts`, and use it in all four.

- [ ] **Step 4: Run** the tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.

- [ ] **Step 5: Commit** `scheduler: parent checks, spec PR scope gate, charter and top designs on the sensitive list, no automation gate (spec 006 AC-10, AC-11, AC-20, AC-21, AC-23)`.

---

### Task 5: Chain machine — escalation path, history, ledger seed, security findings

**Files:**
- Modify: `tools/scheduler/src/chain/types.ts`, `tools/scheduler/src/chain/machine.ts`, `tools/scheduler/src/gates/ready.ts`, `tools/scheduler/src/gates/fix-loop.ts`, `tools/scheduler/src/gates/index.ts`, `tools/scheduler/src/shortlist/select.ts`, `schemas/scheduler/claim.json`
- Test: `tools/scheduler/test/chain.test.ts`, `tools/scheduler/test/gates.test.ts`

**Interfaces:**
- Produces (`chain/types.ts`; all new fields and shapes land here, and Task 6 uses them):
  ```ts
  export type ChainStage = "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge" | "spec" | "question-check"
    | "done" | "released" | "waiting" | "paused" | "abandoned";
  // ChainState: remove securityFinding; add
  track: "issue" | "spec"; rescues: number; specRescues: number; replans: number; specRevisions: number;
  specAnswers: number; decideReturns: number; rescueRun: boolean; history: string[];
  specMode: SpecMode | null; specProblem: string | null; question: Question | null; askingStage: AskingStage | null;
  answer: string | null; answerQuestionId: number | null; answerKind: Question["kind"] | null; recordAnswer: boolean;
  decideInput: string | null; parkedPr: { number: number; head_sha: string } | null;
  pendingSince: string | null; checksRerun: boolean;
  // ChainEvent: remove merge_blocked; `checks` gains at: string and pending?: string[] (the names still pending or missing); add
  | { type: "stage_ok"; stage: "plan" | "implement" | "fix"; ... }   // results may now carry escalation
  | { type: "stage_ok"; stage: "spec"; result: SpecResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "question-check"; result: QuestionCheckResult }
  | { type: "answered"; answer: string; questionId: number }
  // merge_result gains specGate?: { ok: true } | { ok: false; gate: "spec-present" | "ui-design"; reason: string } (spec track only)
  // Action: run_stage and comment unchanged (no rescue, mode or mention field: the driver reads the state). New:
  | { type: "close_pr"; pr: number; branch: string; comment: string }
  | { type: "delete_branch"; branch: string }
  | { type: "finding"; stage: AgentStageName; finding: Finding }
  | { type: "pause"; question: Question; asking: AskingStage }
  | { type: "rerun_checks"; sha: string }
  ```
- Produces (`machine.ts`):
  - `export type LedgerCounts = Pick<ChainState, "rescues" | "specRescues" | "replans" | "specRevisions" | "specAnswers" | "decideReturns" | "history">`;
  - `initialChainState(issue: number, specProblem: string | null = null, ledger: LedgerCounts | null = null)`: seeds the counts and history from the ledger (AC-7);
  - `ledgerOf(state): LedgerCounts`;
  - `normalizeChainState(raw: unknown): ChainState`: fills every missing field with its `initialChainState` default and drops `securityFinding` (AC-7; Task 7 calls it on read);
  - the constants of the global constraints, plus `ABANDONED_LABEL = "abandoned"`, `NEEDS_DECISION_LABEL = "needs-decision"`;
  - `branchOf(state): string`: `` `spec-${issue}` `` when `state.track === "spec"`, otherwise `` `issue-${issue}` ``. Because every entry into the spec stage sets the track (Task 6), this is right for the spec stage on every route, and the driver uses nothing else to name a branch.
- Produces (gates): `readyGate(plan)` returns `ignore(questionsText)` on `spec_gap`; `fixLoopGate(fixes)` returns `ignore(...)` at the bound. `NEEDS_CLARIFICATION`, `NEEDS_HUMAN` and `SECURITY_REVIEW_LABEL` (and its skip in `select.ts`) are removed, now that nothing uses them.

**Rows of spec section 4 this task implements:** the failure rows (postponed, in a rescue run, retry used, `fix` failed, scope violation second time, any route to fix at `fixes = 2`), the review rows for security findings, `approve` and `escalate` of kind `other`, the `liveness_expired` row, and the six `escalate` rows. What the table leaves out:

**History.** `note(state, entry)` appends `entry` truncated to `HISTORY_ENTRY_MAX` and keeps the last `HISTORY_MAX_ENTRIES`. It is called on every `stage_failed` (`"<stage> attempt <n> failed: <reason>"`), every scope violation, every `changes_requested` (the findings text), every failed check (the log excerpt), and by `escalate`.

**Order of the failure rules in `stage_failed`.** First the postponed rule: the whitelist adds `spec` and `question-check`; the state goes to `waiting` with `resumeStage`, and `rescueRun`, the counters and the attempt are untouched, so a 429 during a rescue does not spend it (AC-27). Then, with `rescueRun` set, `escalate` at once without the usual retry. Then the per-stage retry rules.

**The `escalate(state, stuck, reason)` rule** (the six `escalate` rows). `stuck` is the stage whose bound was hit (never `question-check` or `verify`: those map to the asking stage, and verify to `fix`). It notes `${stuck}: ${reason}`, then:
1. **Spec track** (`state.track === "spec"` or `stuck === "spec"`): if `specRescues < MAX_RESCUES`, a rescue of `stuck` with `specRescues + 1`, `rescueRun: true`, `track: "spec"`; otherwise abandon.
2. If `rescues < MAX_RESCUES`, a rescue: `run(stuck)` at attempt 1 with `rescueRun: true`, `rescues + 1`. For a stuck `fix`, `pendingFixInput = reason` (as `toFix` does), so the driver sends it.
3. If `replans < MAX_REPLANS`: when `state.pr` is set, emit `{ type: "close_pr", pr: state.pr.number, branch: branchOf(state), comment: "Closed by the scheduler to re-plan: " + reason }`, built from the state before it changes. The new state has `pr: null`, `plan: null`, `fixes`, `scopeViolations`, `planFailures`, `implementFailures` all 0, `replans + 1`; then `run("plan")`.
4. If `specRevisions < MAX_SPEC_REVISIONS`: `close_pr` as in 3, `pr: null`, `specRevisions + 1`, then enter the spec stage in `revise` mode (Task 6's `toSpec`, which sets the track).
5. Otherwise, abandon. Actions in order:
   - `close_pr` for `state.pr` (when set) and for `state.parkedPr` (when set), each with branch `issue-<issue>` for an issue PR and `branchOf(state)` for the current PR;
   - `comment`, informational and without any @-mention: the bounds hit, the history, and the line "Spec C's re-triage picks this issue up; nothing is needed from the maintainer." The driver appends the issue's run-record paths;
   - `label` add `abandoned`, remove `in-progress` (the driver adds before it removes);
   - `finding` with stage `stuck`, `what: "issue abandoned after the escalation path"`, `where: "issue #N"`, `evidence` the joined history, `noticed_how: "scheduler escalation"`;
   - `notify` with gate `abandoned` and label `abandoned`;
   - `done`.

   The stage is `abandoned`. The issue is not closed (AC-5). Task 8 makes this list crash-safe.

**When `escalate` replaces `needsHuman`:** every current `needsHuman` call; `toFix` at the fix bound (stuck `fix`, with the fix input as `pendingFixInput`); the rescue-run rule above; a `stage_failed` of `spec` after its one retry. `stage_ok` of any stage clears `rescueRun`.

**Liveness on the spec track.** `liveness_expired` with `track: "spec"` prepends `close_pr` for `state.pr` (branch `spec-<issue>`) when set, otherwise `delete_branch` `spec-<issue>`, to today's release actions (AC-21). On the issue track it is unchanged.

**Security** (AC-9): in `review`, findings with `state.sensitive || event.security` go to `toFix` with the findings text. Without findings, `approve` merges. The `securityFinding` hold and the `merge_blocked` event are gone.

- [ ] **Step 1: Rewrite `test/chain.test.ts`.** Keep the happy path; replace every `needs-human` test.

```ts
it("plan failing twice runs a rescue plan with the history (AC-1, AC-7)", () => {
  const r = transition(at("plan", { planFailures: 1 }), { type: "stage_failed", stage: "plan", reason: "boom" });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
  expect(r.state).toMatchObject({ rescues: 1, rescueRun: true });
  expect(r.state.history.at(-1)).toMatch(/plan.*boom/);
});
it("every failure is noted, capped and trimmed (AC-7)", () => { /* stage_failed with a 10k reason -> entry length 4000; 25 notes -> 20 kept */ });
it("fix loop exhaustion rescues with a fix run (AC-1)", () => { /* review changes_requested at fixes: 2 -> run_stage fix; state.pendingFixInput contains "Review requested changes" */ });
it("a failed rescue re-plans: close_pr carries the old PR, counters reset (AC-2, review focus 6)", () => {
  const s = at("implement", { rescueRun: true, rescues: 1, pr: { number: 3, head_sha: "b".repeat(40) }, fixes: 2, implementFailures: 1 });
  const r = transition(s, { type: "stage_failed", stage: "implement", reason: "x" });
  expect(r.actions[0]).toEqual({ type: "close_pr", pr: 3, branch: "issue-1", comment: expect.stringContaining("re-plan") });
  expect(r.actions.at(-1)).toEqual({ type: "run_stage", stage: "plan", attempt: 1 });
  expect(r.state).toMatchObject({ pr: null, plan: null, fixes: 0, implementFailures: 0, replans: 1 });
});
it("a quota failure in a rescue run postpones it without spending it (AC-27)", () => {
  const r = transition(at("plan", { rescueRun: true, rescues: 1 }), { type: "stage_failed", stage: "plan", reason: "429", postpone: true });
  expect(r.state).toMatchObject({ stage: "waiting", resumeStage: "plan", rescueRun: true, rescues: 1, replans: 0 });
});
it("after a re-plan the next bound revises the spec on the spec track (AC-3)", () => { /* rescues 1, replans 1 -> run_stage spec; specMode revise, specRevisions 1, track spec */ });
it("after a spec revision the next bound abandons, in order, issue left open, nobody mentioned (AC-5)", () => {
  const r = transition(at("fix", { rescues: 1, replans: 1, specRevisions: 1, pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "stage_failed", stage: "fix", reason: "x" });
  expect(r.actions.map((a) => a.type)).toEqual(["close_pr", "comment", "label", "finding", "notify", "done"]);
  expect((r.actions[1] as { text: string }).text).not.toMatch(/@/);
  expect(r.actions[2]).toEqual({ type: "label", add: ["abandoned"], remove: ["in-progress"] });
  expect(r.state.stage).toBe("abandoned");
});
it("abandonment closes a parked issue PR too (AC-5)", () => { /* track spec, specRescues 1, pr 12, parkedPr 9 -> two close_pr: 12 on spec-1, 9 on issue-1 */ });
it("on the spec track the first bound rescues and the second abandons (AC-5)", () => { /* track spec, fixes 2, changes_requested -> rescue fix, specRescues 1; again -> abandoned */ });
it("liveness on the spec track closes the spec PR, or deletes spec-<issue> without one (AC-21)", () => {});
it("a seeded ledger carries counts into a new chain (AC-7)", () => { /* initialChainState(1, null, { rescues: 1, ... }) then a bound -> re-plan, not rescue */ });
it("normalizeChainState loads a pre-006 claim state (AC-7)", () => { /* fixture with securityFinding and no track -> track issue, rescues 0, history [], no securityFinding */ });
it("security findings go to fix, approval merges, no labels (AC-9)", () => { /* as before: run_stage fix with fixInput; approve -> [merge] */ });
it("the escalation bounds (AC-6)", () => {
  expect([MAX_RESCUES, MAX_REPLANS, MAX_SPEC_REVISIONS, MAX_SPEC_ANSWERS, MAX_DECIDE_RETURNS, VERIFY_PENDING_MAX_H, MAX_FIXES]).toEqual([1, 1, 1, 1, 1, 6, 2]);
});
```

In `test/gates.test.ts`: `readyGate(spec_gap)` and `fixLoopGate(2)` give `action: "ignore"`.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/chain.test.ts tools/scheduler/test/gates.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the types, `note`, `escalate`, the replaced call sites, the failure order, the security change, the spec-track liveness actions, the gate returns, and `claim.json`'s `state` properties to match `ChainState`.

- [ ] **Step 4: Run** the tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean. To keep `driver.ts` compiling until Task 8, make only these edits: drop the security-label read in `mergeEvent`; pass `at: now` on `checks`; set `ENDED` to `["done", "released", "abandoned", "paused"]`; ignore the new action types in `applyActions` (`default` arm). Driver tests asserting `needs-human` move to `it.todo("spec 006 Task 8: …")`.

- [ ] **Step 5: Commit** `scheduler: rescue, re-plan, spec revision and abandonment in place of needs-human; per-issue history; security findings to the fix loop (spec 006 AC-1 to AC-7, AC-9, AC-27)`.

---

### Task 6: Chain machine — spec stage, spec track, questions, answers

**Files:**
- Modify: `tools/scheduler/src/chain/machine.ts`
- Test: `tools/scheduler/test/chain.test.ts`

**Interfaces:**
- Consumes: Task 5's types, `note`, `escalate`, `branchOf`.
- Produces the remaining rows of spec section 4: the `claimed` rows, the `plan` `spec_gap` rows, the follow-up row, the `escalation` rows, the `verify` rows, review `escalate` of other kinds, the `spec` rows, the four `merge, spec track` rows, the `question check` rows and the `paused` rows. After this task the machine accepts exactly the valid-event list of section 4 (`rebase_conflict` stays invalid in `spec` and `question-check`; `liveness_expired` becomes invalid in the ended stages).
- Produces `formatQuestion(q: Question, maintainer: string, nonce: string): string`. Exact first line `### Question for the maintainer`, then `@<maintainer>`, the question, a numbered list of `label — cost`, `Recommendation: …`, the line `Reply in a comment on this issue; the scheduler resumes on your reply.`, and last `<!-- panelator-question:<nonce> -->`. The driver calls it (Task 8); the machine does not know the maintainer.

What the table leaves out, row group by row group:

- **Entering the spec stage.** One helper, `toSpec(state, mode, patch)`, sets `track: "spec"`, `specMode: mode` and runs `spec`. Every row whose target is the spec stage uses it, including the `revise` step of `escalate`, a spec-track rescue of `spec`, and the `waiting` resume (which keeps the saved mode).
- **`claimed`, `start`:** with `specProblem` set, `toSpec("write")`; otherwise run `plan`.
- **`plan`, `spec_gap`:** the first sets `specProblem` to the `readyGate` reason and `specAnswers + 1`, then `toSpec("answer")`. The second is `escalate(state, "plan", "spec gap after an answered gap: " + reason)`.
- **Follow-up** (AC-15). Checked before the rules below: when `state.answer` is set and the result carries a question (an `escalation` on plan, implement or fix; a review `escalate` or a spec `question` of a kind other than `other`), the stage is `paused`, `question` and `askingStage` are set, and the actions are `[{ type: "pause", question, asking }]`. No counter changes and nothing is noted as a failure.
- **`escalation` on plan, implement, fix; review `escalate` of other kinds; spec `question` of other kinds:** with `decideInput` set (decide mode), handled as a `stage_failed` of that stage with reason `"escalated in decide mode"`. Otherwise `question` and `askingStage` are set, and `question-check` runs.
- **Spec `question` of kind `other`:** handled as a `decide_yourself` from the check, with reasoning `"kind other is not a question for the maintainer"`, counted in `decideReturns`.
- **`verify`, `checks`:** `pending` sets `pendingSince = event.at` when null. When `event.at - pendingSince >= VERIFY_PENDING_MAX_H`:
  - with `checksRerun` false: actions `[{ type: "rerun_checks", sha: pr.head_sha }]`, then `toFix` with the input `"Required checks <event.pending> have been pending for 6 hours on <sha>; the scheduler has re-run those it could. Investigate why they never report: the workflow files and triggers that should produce them, and whether each check has a run. Fix the cause if it is in this repository; otherwise change nothing and say so."`; `checksRerun: true`, `pendingSince: null`;
  - with `checksRerun` true: a `capability` question ("A required check never reported on PR #n", options "fixed, re-check" and "drop the check from `required_checks`", each with a cost, and a recommendation), `askingStage: "verify"`, run `question-check`.

  `green` and `failed` clear `pendingSince` and `checksRerun`, and clear `answer`, `answerQuestionId` and `answerKind` (the reply was an input to verify only). A failed check is noted.
- **`spec`, `stage_ok`, `revised`:** `pr: { number, head_sha }`, `fixes: 0`, `scopeViolations: 0`; `specMode`, `decideInput` and `answer` are cleared, while `answerQuestionId` and `answerKind` stay until the spec-track merge (a fix on the spec PR is scope-checked with them, Task 8). With `event.scope.ok`, stage `verify` and actions `[{ type: "verify" }]`; otherwise the violation is noted and goes to `toFix` with `scopeViolations: 1`, as implement's first violation (AC-22).
- **`merge`, `merged` on the spec track,** all with `delete_branch` `spec-<issue>` first, the merge not being `done`:
  - `specGate.ok` with `parkedPr`: `pr: parkedPr`, `parkedPr: null`, `track: "issue"`, the stage counters 0, `specProblem`, `specMode` and the answer fields cleared; then `toFix` with `"Apply the maintainer's decision to question #<answerQuestionId>, now recorded on main. Read it in the spec and the top designs, then change this PR to follow it."`;
  - `specGate.ok` without one: `track: "issue"`, `pr: null`, `plan: null`, the stage counters 0, `specProblem`, `specMode` and the answer fields cleared, then run `plan`;
  - `spec-present` failed: `pr: null`, `specProblem: reason`, `specMode: "write"`, the track stays `spec`, then `escalate(state, "spec", "spec-present failed after merge: " + reason)`;
  - `ui-design` failed: `pr: null`, stage `released`; actions: a comment with the reason, `label` add `needs-design-stage` remove `in-progress`, one `notify`, `release` without a patch. The ledger is not archived.
- **`question-check`, `stage_ok`:** `send` gives stage `paused` and `[{ type: "pause", question, asking }]`. `decide_yourself` adds 1 to `decideReturns`; with `asking === "verify"`, or above `MAX_DECIDE_RETURNS`, `escalate(state, asking === "verify" ? "fix" : asking, "decide_yourself: " + reasoning)`; otherwise the asking stage runs with `decideInput = reasoning` (for `spec`, `toSpec("decide")`).
- **`question-check`, `stage_failed`:** attempt 1 retries at attempt 2; otherwise `escalate` with the asking stage (verify maps to `fix`) as the stuck stage.
- **`paused`, `answered`:** sets `answer`, `answerQuestionId = event.questionId`, `answerKind = question.kind`, clears `question`, then routes as the five `paused` rows:
  - asked by `spec`: `toSpec(saved specMode)`;
  - kind `capability`: the asking stage again; for `verify`, stage `verify` with `pendingSince: null` and actions `[{ type: "verify" }]`;
  - kind `product`, asked by plan or implement: `toSpec("record")`;
  - kind `product`, asked by review or fix: `parkedPr: state.pr`, `pr: null`, then `toSpec("record")`;
  - kind `technical`, asked by plan or implement: `toSpec("record")`;
  - kind `technical`, asked by review or fix: `recordAnswer: true`, then `toFix` with `"Record the maintainer's decision as an ADR under docs/decisions/, marked (maintainer answer, question #<id>), then apply it:\n" + question + "\nAnswer: " + answer`. At `fixes = 2` this escalates like any route to fix.
- **Clearing.** `stage_ok` of the stage that received `decideInput` clears it. On the issue track, `stage_ok` of the stage that received `answer` clears `answer`, `answerQuestionId` and `answerKind`; a fix's `stage_ok` also clears `recordAnswer`. Only a review or fix asking a technical question sets `recordAnswer`, so a capability answer never requires an ADR.

- [ ] **Step 1: Write the failing tests** in `test/chain.test.ts`:

```ts
it("a claimed issue with a spec problem starts at the spec stage in write mode on the spec track (AC-19, AC-21)", () => {
  const r = transition(initialChainState(1, "specs/010-x/spec.md not found on main"), { type: "start" });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
  expect(r.state).toMatchObject({ specMode: "write", track: "spec" });
  expect(branchOf(r.state)).toBe("spec-1");
});
it("every transition into the spec stage sets the spec track (AC-21, review focus 12)", () => {
  // claimed start, plan spec_gap, escalate revise, answered from plan, answered from review (product), decide_yourself for spec, spec-track rescue of spec, waiting resume:
  // each result with stage "spec" has track "spec" and branchOf "spec-1".
});
it("spec_gap goes to the spec stage in answer mode once; the second escalates (AC-1, AC-19)", () => { /* first: no label, specMode answer, specAnswers 1; second: rescue plan */ });
it("a revised spec goes through verify on the spec track, then back to plan after merge (AC-4)", () => {
  let r = transition(at("spec", { specMode: "revise", track: "spec" }), { type: "stage_ok", stage: "spec", result: revised, scope: { ok: true } });
  expect(r.state).toMatchObject({ track: "spec", stage: "verify", pr: { number: 8 } });
  r = transition({ ...r.state, stage: "merge" }, { type: "merge_result", status: "merged", specGate: { ok: true } });
  expect(r.state).toMatchObject({ track: "issue", stage: "plan", pr: null });
  expect(r.actions).toEqual([{ type: "delete_branch", branch: "spec-1" }, { type: "run_stage", stage: "plan", attempt: 1 }]);
});
it("after a spec-track merge, a spec-present failure reruns the spec stage within bounds and a UI failure parks the issue (AC-4)", () => {
  // spec-present failed, specRescues 0 -> run_stage spec, specMode write, specProblem the reason, rescueRun true; specRescues 1 -> abandoned
  // ui-design failed -> stage released; label add needs-design-stage remove in-progress; no finding
});
it("a merged record PR restores the parked issue PR and runs a fix (AC-18)", () => {});
it("a spec PR scope violation goes to one fix, the second escalates (AC-22)", () => { /* revised with scope violated -> run fix, scopeViolations 1; fix stage_ok with violation -> rescue (spec track) */ });
it("a review escalation of kind technical goes to the question check (AC-8, AC-12)", () => { /* askingStage review, run_stage question-check */ });
it("an implement result with a capability escalation goes to the question check (AC-17)", () => {});
it("checks pending six hours re-run and investigate first, then ask (AC-17)", () => {
  // pending at t0, t0+5h59 -> wait; t0+6h -> [rerun_checks, run_stage fix], checksRerun true, pendingSince null;
  // later pending at t1, t1+6h -> run_stage question-check, askingStage verify, question.kind capability
});
it("send pauses with a single pause action (AC-13)", () => {
  const r = transition(at("question-check", { question: q, askingStage: "spec" }), { type: "stage_ok", stage: "question-check", result: { verdict: "send", reasoning: "r" } });
  expect(r.actions).toEqual([{ type: "pause", question: q, asking: "spec" }]);
  expect(r.state.stage).toBe("paused");
});
it("a question from a stage resumed with a reply is a follow-up: paused at once, nothing counted (AC-15)", () => {
  // at("implement", { answer: "tell me more", answerQuestionId: 5 }) + implement stage_ok with escalation -> [pause], no question-check, decideReturns 0, implementFailures 0
});
it("decide_yourself reruns the asker in decide mode; the second one escalates (AC-14)", () => {});
it("decide_yourself for verify escalates with a rescue fix (AC-14)", () => {});
it("a question in decide mode counts as a failed run (AC-14)", () => {});
it("a spec question of kind other counts as a decide_yourself (AC-14)", () => {});
it("a failing question check retries once, then escalates the asking stage (AC-12)", () => {});
it("answers route by asking stage and kind (AC-18)", () => {
  // spec -> spec, same mode; plan technical -> spec record; plan product -> spec record; review product -> parkedPr set, pr null, spec record;
  // review technical -> fix, recordAnswer true, pendingFixInput contains "docs/decisions/" and "question #5"; verify capability -> verify, pendingSince null, recordAnswer false
});
it("an answer at the fix bound escalates (AC-18)", () => { /* paused, askingStage review, technical, fixes 2, rescues 1 -> close_pr then run_stage plan */ });
it("answer fields clear on the resumed stage's success, and when verify moves on (AC-18)", () => {});
it("a postponed spec stage resumes in the same mode on the spec track", () => {});
it("formatQuestion: heading, mention, nonce last", () => {
  const lines = formatQuestion(q, "m", "n1").split("\n");
  expect(lines.slice(0, 2)).toEqual(["### Question for the maintainer", "@m"]);
  expect(lines.at(-1)).toBe("<!-- panelator-question:n1 -->");
});
it("every event in every stage: valid pairs never throw, invalid pairs throw the invalid-event error, nothing waits on a human but paused (AC-27)", () => {
  // EVENTS: one fixture per event shape (each stage_ok and stage_failed variant, postponed, checks x3, merge_result x2 with and without specGate, head_moved, rebase_conflict, answered, liveness_expired, start).
  // STAGES: every ChainStage, each with a state fixture that makes the transition meaningful (question set in question-check and paused, pr set where needed), on both tracks where the track changes the row.
  // VALID(stage, event): spec section 4 "Valid events", written out as a table in the test.
  // For each pair: if VALID, expect no throw, the resulting stage not "needs-human", no label action adding "needs-human", and a stage of "spec" only with track "spec";
  // otherwise expect it to throw /^invalid event /; any other error fails.
  // Extra rows: a postponed stage_failed with rescueRun true leaves rescueRun true and every counter unchanged.
});
```

- [ ] **Step 2: Run** the chain tests. Expected: FAIL.
- [ ] **Step 3: Implement** the transitions, `toSpec` and `formatQuestion`.
- [ ] **Step 4: Run** the chain tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `scheduler: spec stage, spec track, question check, follow-ups, pause and answer routing in the chain (spec 006 AC-4, AC-8, AC-12 to AC-15, AC-17 to AC-19, AC-21, AC-22, AC-27)`.

---

### Task 7: State records, GitHub calls and worktree branches

**Files:**
- Create: `tools/scheduler/src/state/paused.ts`, `tools/scheduler/src/state/ledger.ts`, `tools/scheduler/src/state/questions.ts`, `tools/scheduler/test/paused.test.ts`
- Modify: `tools/scheduler/src/state/paths.ts`, `tools/scheduler/src/state/claims.ts`, `tools/scheduler/src/github/client.ts`, `tools/scheduler/src/github/types.ts`, `tools/scheduler/src/runner/worktree.ts`, `tools/scheduler/test/helpers/mock-github.ts`, `schemas/scheduler/claim.json`
- Test: `tools/scheduler/test/client.test.ts`, `state.test.ts`, `worktree.test.ts`

**Interfaces:**
- Produces (`state/paused.ts`):
  ```ts
  export interface PausedRecord {
    issue: number; phase: "pausing" | "paused" | "resuming"; state: ChainState; question: Question; asking_stage: AskingStage;
    nonce: string;                                                 // random, written in phase pausing, embedded in the question comment
    question_comment_id: number | null; asked_at: string | null;   // from GitHub's response to the question comment
    reminded: boolean; answer: string | null; reply_comment_id: number | null;
  }
  export const REMINDER_AFTER_H = 24;
  export async function writePaused(p: StatePaths, r: PausedRecord): Promise<void>   // validates against "paused", atomic write like writeClaim
  export async function listPaused(p: StatePaths): Promise<PausedRecord[]>            // state passed through normalizeChainState
  export async function removePaused(p: StatePaths, issue: number): Promise<void>
  export interface IssueComment { id: number; author: string; at: string; body: string }
  export function pausedDecision(r: PausedRecord, comments: IssueComment[], maintainer: string, now: Date):
    { kind: "resume"; answer: string; replyId: number } | { kind: "remind" } | { kind: "wait" }
  export function questionMarker(nonce: string): string   // "<!-- panelator-question:<nonce> -->", shared with formatQuestion
  ```
  `pausedDecision` resumes on the earliest comment by `maintainer` with `id > question_comment_id` and `at > asked_at`. With none, it returns `remind` when `!reminded` and `now - asked_at >= 24h`; otherwise `wait`. A record with `question_comment_id: null` always returns `wait` (Task 9 completes it first).
- Produces (`state/ledger.ts`): `readLedger(p, issue): Promise<LedgerCounts | null>`, `writeLedger(p, issue, counts: LedgerCounts): Promise<void>` (validates against `escalation-ledger`, atomic), `archiveLedger(p, issue, now): Promise<void>` (renames it to `escalations/<issue>.abandoned-<timestamp>.json`, so if the `abandoned` label is removed, the next claim starts fresh).
- Produces (`state/questions.ts`): `appendQuestionLog(p, entry: { issue: number; at: string; event: "asked" | "checked" | "sent" | "reminded" | "answered"; asking_stage: AskingStage; question_comment_id?: number; question?: Question; verdict?: string; reasoning?: string; reply_comment_id?: number; answer?: string })`, validated against `question-log-entry`; `answeredEntry(p, questionCommentId): Promise<Entry | null>` (the citation check and the resume's no-duplicate rule both use it).
- Produces (`state/claims.ts`): `Claim` gains `pendingEvent?: ChainEvent` (only `answered`) and `pendingActions?: Action[]`; `claim.json` gains both. `readClaim` and `listClaims` pass `state` through `normalizeChainState`.
- Produces: `StatePaths.paused = join(root, "paused")`, `StatePaths.escalations = join(root, "escalations")`, `StatePaths.questionsLog = join(root, "questions", "log.jsonl")`, all created by `ensureStateDirs`.
- Produces (`GitHubClient`):
  - `comment(issue, body): Promise<{ id: number; created_at: string }>` (callers that ignore the result are unchanged);
  - `listComments(issue: number): Promise<IssueComment[]>`, paginated with `per_page=100`;
  - `issueComment(id: number): Promise<IssueComment | null>`, a GET of `issues/comments/{id}`; a 404 is `null`;
  - `closePullRequest(n: number): Promise<void>`, a PATCH with `state: "closed"`;
  - `deleteBranch(branch: string): Promise<void>`, a DELETE of `git/refs/heads/{branch}`; a 422 or 404 is ignored;
  - `setIssueBody(issue: number, body: string): Promise<void>`;
  - `rerequestCheckRun(id: number): Promise<boolean>`, a POST of `check-runs/{id}/rerequest`; a 4xx returns `false` (a run GitHub will not re-run);
  - `PullRequestInfo.body: string`.
- Produces (`runner/worktree.ts`):
  - `checkoutBranch(worktree: string, branch: string, base: string): Promise<void>`, which is `git checkout -B <branch> <base>`;
  - `deleteLocalBranch(worktree: string, branch: string): Promise<void>`; a missing branch is ignored.

- [ ] **Step 1: Write the failing tests.**
  - **`pausedDecision`** (`test/paused.test.ts`):
    - resumes with the maintainer's comment body and its id;
    - ignores a maintainer comment whose id is at or below `question_comment_id`, even when its time is later (review focus 1);
    - ignores comments by `panelator-pipeline[bot]` and by other users;
    - returns `remind` at 24h with `reminded: false`, and `wait` at 23h59m;
    - returns `wait` at 48h with `reminded: true` (AC-16).
  - **Records:** `writePaused` then `listPaused` round-trips, and `removePaused` deletes the record. `writeLedger`, then `readLedger`, round-trips; `archiveLedger` makes `readLedger` return `null`. `appendQuestionLog` writes one valid line per call; `answeredEntry` finds an `answered` line by question comment id and returns `null` for an id only `sent`.
  - **Old claims** (`test/state.test.ts`): a claim file with a pre-006 state (has `securityFinding`, lacks `track` and the counters) reads back through `readClaim` and `listClaims` with `track: "issue"`, `rescues: 0`, `history: []`. A claim with `pendingEvent` and `pendingActions` round-trips.
  - **Client** (`test/client.test.ts`), using `mockGitHub`: each new method issues the expected method and path. `comment` returns the mock's `id` and `created_at`. `listComments` follows a two-page `Link` header (use `pageLink` from the helper) and maps `id`, `user.login`, `created_at` and `body`. `issueComment` maps the same fields and returns `null` on 404. `rerequestCheckRun` returns `false` on 422. `pullRequest` maps `body`.
  - **Worktree** (`test/worktree.test.ts`): from a worktree on `spec-7` with a commit, `checkoutBranch(wt, "issue-7", "origin/main")` leaves HEAD on `issue-7` at `origin/main`; `deleteLocalBranch(wt, "spec-7")` removes it.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/paused.test.ts tools/scheduler/test/client.test.ts tools/scheduler/test/state.test.ts tools/scheduler/test/worktree.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The mock's comment route returns an incrementing `id` and the mock clock's `created_at`.
- [ ] **Step 4: Run** the tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `scheduler: paused records, escalation ledger, questions log, claim markers and normalization, and the GitHub and branch calls they need (spec 006 AC-5, AC-7, AC-10, AC-13, AC-15, AC-16, AC-17, AC-18)`.

---

### Task 8: Driver — branches, new actions, rescue model, spec track, stage inputs

**Files:**
- Modify: `tools/scheduler/src/chain/driver.ts`
- Test: `tools/scheduler/test/driver.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `cfg.rescue_model`, the stage definitions, `afterFallback`;
  - Task 4: `specScopeGate`, `scopeGate`'s `extraAllowed`, `specPresentGate`, `uiDesignGate`;
  - Tasks 5 and 6: actions, events, `branchOf`, `ledgerOf`, `formatQuestion`;
  - Task 7: records, claim markers, client calls, worktree branch calls;
  - `harnessForModel` from `runner/retry.ts`.
- Produces:
  - **`AGENT_STAGES`** includes `spec` and `question-check`. **`ENDED`** is `["done", "released", "abandoned", "paused"]`.
  - **`step()` order.** Before the `ENDED` check:
    1. a claim with non-empty `pendingActions` applies them in order, rewriting the claim after each with that action removed, and ends as they say (no transition runs);
    2. a claim with `pendingEvent` uses it as the event, instead of running the stage, and drops it from the claim. The transition, the ledger write, the actions and the claim write then run exactly as for any other event (AC-15). This is how a resumed issue's `answered` transition, with its actions, takes effect.
  - **Abandonment is crash-safe** (AC-5, review focus 11). When a transition's new stage is `abandoned`, the driver first writes the claim with the new state and `pendingActions` set to the whole action list, then applies them through rule 1. A crash repeats at most the action in flight; `close_pr` on an already closed PR and `deleteBranch` of a deleted branch are harmless.
  - **`syncWorktree`.** After saving leftovers as today:
    - with no PR, it saves unmerged commits as today, then runs `checkoutBranch(worktree, branchOf(state), "origin/main")` in place of `resetToBase`. That is how the scheduler prepares `spec-<issue>` before the spec stage (the track is already `spec` on every route, Task 6), and how it returns to `issue-<issue>` after a spec-track merge;
    - with a PR, it checks out `branchOf(state)` when HEAD is on another branch (from `origin/<branch>`), then calls `syncToRemote(worktree, "origin/" + branchOf(state))`.
  - **Rebase**: skipped for the `spec` and `question-check` stages; otherwise as today.
  - **Retry.** After a fallback run, `afterFallback(def, judgement)` returning `postpone` gives `stage_failed` with `postpone: true` (AC-26).
  - **`prBound(deps, claim, bound: { prNumber: number; branch: string }, headSha: string)`.** Implement passes `result.pr_number` and `branchOf`; fix passes `state.pr.number` and `branchOf`; the spec stage passes `result.pr_number` and `spec-<issue>`. The question check, and any result carrying `escalation`, skip it and the scope check; a plan result carrying `escalation` also skips the domain-profile check (review focus 9).
  - **`buildInput`** fills:
    - `history: state.history.join("\n\n")`;
    - `question`: `formatQuestion(state.question, cfg.maintainer, "")` without its last (marker) line, when set;
    - `answer` (prefixed `Question #<answerQuestionId>: `), `mode: state.specMode`, `decide_input: state.decideInput` and `spec_problem: state.specProblem`;
    - for review, `answered_questions`: every id matched by `/question #(\d+)/` in the added lines of `git diff origin/main...HEAD`, one line each. An id is verified when `answeredEntry(paths, id)` exists, or `issueComment(id)` returns a comment whose author is `cfg.maintainer`. A verified line is `#<id>: verified. Question: <first line>. Answer: <answer>`; any other is `#<id>: NOT verified; treat as no citation`. No cited id gives `(none)` (AC-10, review focus 10).
  - **Rescue.** When `state.rescueRun` is set, the first `exec` uses `(cfg.rescue_model, harnessForModel(cfg.rescue_model))`. The action carries no rescue or mode field; the state is the only source.
  - **Profiles.** For review, `security` when the diff is sensitive, else `spec` on the spec track, else as today (the security profile wins over `spec`). The question check gets `null`.
  - **Spec stage `stage_ok` with `revised`.** The driver checks, in order, and emits `stage_failed` on the first failure:
    1. `spec_path` is under `specs/` with no `..` segment (review focus 4): `"result: spec_path outside specs/"`;
    2. when the issue body has a `Spec:` line, `spec_path` equals it: `"result: spec_path differs from the issue's Spec: line"` (AC-21);
    3. `prBound` for `spec-<issue>`: `"result: pr mismatch"`;
    4. the PR body has no closing keyword (`/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+#\d+/i`): `"result: spec PR body closes an issue"`;
    5. with `state.answerQuestionId` set, the diff's added lines contain `(maintainer answer, question #<answerQuestionId>)`: `"result: answer not marked"` (AC-18).

    Then it runs `specScopeGate` over the diff. `parentPath` is the `Parent:` of the spec in the worktree, `parentBefore` comes from `origin/main`, `parentAfter` from the worktree, and `recordsProductAnswer` is `state.answerKind === "product"`. The result is passed as `scope` on the event. When the issue body has no `Spec:` line, `setIssueBody` appends `\n\nSpec: <spec_path>`.
  - **Spec-track implement and fix results** use `specScopeGate` the same way, with the spec path from the issue body.
  - **A fix while `state.recordAnswer` is set** (AC-18): `scopeGate` gets `extraAllowed: ["docs/decisions/"]`. A diff that adds no file under `docs/decisions/` (`git diff --diff-filter=A --name-only origin/main...HEAD`) whose text contains the mark for `answerQuestionId` is `stage_failed` with `"result: answer not recorded under docs/decisions/"`. A fix with `answer` set for a capability question has no such check.
  - **`verifyEvent`** passes `pending`: the required check names not completed or missing.
  - **`mergeEvent`** no longer reads labels for `security-review`. On the spec track it skips `appendMerge`, and after `merged` it fetches and runs `specPresentGate` (spec path from the issue body, files read from `origin/main`) and then `uiDesignGate` on the spec from `origin/main`, passing the first failure, or `{ ok: true }`, as `specGate` (AC-4).
  - **`applyActions`:**
    - `close_pr`: save `commitsPatch(worktree, "origin/main")` as kind `"closed-pr"`, then `comment(a.pr, a.comment)`, `closePullRequest(a.pr)` and `deleteBranch(a.branch)`, all from the action's fields, never from `claim.state.pr`;
    - `delete_branch`: `checkoutBranch(worktree, "issue-<issue>", "origin/main")`, `deleteLocalBranch(worktree, a.branch)`, `deleteBranch(a.branch)`;
    - `rerun_checks`: from `checks(a.sha, cfg.required_checks)`, `rerequestCheckRun` for each required run not completed; refusals and missing checks are logged (the fix input already names them);
    - `finding`: `appendFindings(paths, { issue, stage, run_id: "escalation", timestamp }, [finding])`;
    - `comment` on an abandoned state: the issue's run-record paths are appended;
    - `pause` (AC-13), in this order:
      1. `writePaused({ phase: "pausing", nonce: randomUUID(), state, question, asking_stage, question_comment_id: null, asked_at: null, reminded: false, answer: null, reply_comment_id: null })`;
      2. `comment(issue, formatQuestion(question, cfg.maintainer, nonce))`;
      3. rewrite the record with the returned `id` and `created_at`;
      4. add `needs-decision`, then remove `in-progress`;
      5. `notify` with gate `question`;
      6. rewrite the record with `phase: "paused"`;
      7. `appendQuestionLog` `sent` with the question comment id;
      8. `removeClaim`.

      The status is `"ended"`, and the worktree is kept;
    - `done` on an `abandoned` state also calls `archiveLedger` after the finding is written.
  - **Ledger and log in `step()`.** After `transition`, when `ledgerOf(new)` differs from `ledgerOf(old)`, `writeLedger` runs before `applyActions`. Entering `question-check` appends `asked`; its `stage_ok` appends `checked` with the verdict and reasoning.

- [ ] **Step 1: Write the failing tests** in `test/driver.test.ts`. Replace the `it.todo` entries from Task 5:
  - A plan that fails twice runs a third plan whose model is `claude-fable-5-1`: the scripted adapter's `ran` list shows `plan:claude-fable-5-1` last, the claim's `state.rescues` is 1, and `escalations/7.json` has `rescues: 1`.
  - A rescue run's prompt contains the history text (assert on the prompt file the runner writes under `runs/<id>/`).
  - A question check whose primary and fallback runs both end with a 429 leaves the claim `waiting` with `resumeStage: "question-check"`, and both runs have usage records with stage `question-check` (AC-26).
  - A plan result holding only an `escalation` with a domain that has no profile reaches the question check, not `profile not available` (review focus 9).
  - A re-plan with PR 9 open: PATCH `/repos/o/r/pulls/9` with `state: "closed"`, a comment on 9, and DELETE `/repos/o/r/git/refs/heads/issue-7`, all after the claim's `state.pr` is `null` (review focus 6).
  - An `abandoned` chain makes these calls in order: the PR close calls; a comment with no `@`; labels `+abandoned` before `-in-progress`; one line in `findings/queue.jsonl`; one notification. It makes no PATCH of the issue's `state`, and the ledger is archived.
  - **Crash mid-abandon** (review focus 11): a claim with stage `abandoned` and `pendingActions` holding the `label`, `finding`, `notify` and `done` actions posts no comment, applies the labels once, writes one finding and one notification, and removes the claim.
  - **Resume applies the transition** (AC-15): a claim with the paused state (`askingStage: "review"`, a technical question, `fixes: 2`, `rescues: 1`, PR 9) and `pendingEvent: { type: "answered", … }` makes one `step()` PATCH PR 9 closed and DELETE `issue-7` (the escalation's re-plan actions run), write `escalations/7.json` with `replans: 1`, and leave a claim without `pendingEvent`.
  - The spec stage runs with HEAD on `spec-7` both from a claim with a missing spec and from a plan `spec_gap` (review focus 12). After a spec-track merge, the next implement runs with HEAD on `issue-7`, and `spec-7` is gone locally and was DELETEd remotely (review focus 7).
  - After a spec-track merge whose spec now fails spec-present on `origin/main`, the spec stage runs again on the rescue model in `write` mode; when the UI-design gate fails instead, the issue gets `needs-design-stage`, the claim is removed, and `escalations/7.json` still exists (AC-4).
  - A spec `revised` result with `spec_path: "specs/../docs/charter.md"` is a failed run, and the issue body is not PATCHed (review focus 4).
  - A spec `revised` result whose `spec_path` differs from the issue body's `Spec:` line is a failed run (AC-21).
  - A spec PR whose body is `Closes #7` is a failed run.
  - A spec PR diff touching `docs/charter.md` reaches the machine as `scope.ok === false`.
  - A spec `revised` result for an issue whose body lacks a `Spec:` line PATCHes the body to end with `Spec: specs/010-thing/spec.md`.
  - A spec-track review on a diff touching `docs/delivery-system-design.md` uses the `security` profile.
  - A review whose diff cites three ids, one with an `answered` log entry, one a maintainer comment, one a 404, renders `answered_questions` with two `verified` lines and one `NOT verified` line (review focus 10).
  - A `send` leaves `paused/7.json` with `phase: "paused"`, a nonce that the posted comment's last line carries, and the mock's comment id and `created_at`; removes `claims/7.json`; keeps the worktree; and logs `asked`, `checked` and `sent`.
  - A fix with `recordAnswer` whose diff adds no marked `docs/decisions/` file is a failed run; a fix after a capability answer with no such file is not.
  - Six hours of pending checks POSTs `check-runs/<id>/rerequest` for the pending run, then runs a fix whose input names the check.
  - A liveness release on the spec track with spec PR 12 PATCHes 12 closed and DELETEs `spec-7`.
  - A merged spec PR adds no line to `merges.jsonl`.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/driver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the driver tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean, with no `it.todo` left from Task 5 and no `default: throw` arm left from Task 2.
- [ ] **Step 5: Commit** `scheduler: driver carries out rescue, re-plan, spec PRs and their branches, pause, resume and abandonment (spec 006 AC-1 to AC-5, AC-7, AC-10, AC-13, AC-15, AC-17, AC-18, AC-21, AC-22, AC-26)`.

---

### Task 9: Shortlist spec starts and the service loop — resume on reply, reminders

**Files:**
- Modify: `tools/scheduler/src/gates/spec-present.ts`, `tools/scheduler/src/gates/index.ts`, `tools/scheduler/src/shortlist/select.ts`, `tools/scheduler/src/service/loop.ts`
- Test: `tools/scheduler/test/gates.test.ts`, `shortlist.test.ts`, `loop.test.ts`

**Interfaces:**
- Consumes: `initialChainState(issue, specProblem, ledger)` (Task 5); paused records, `pausedDecision`, `questionMarker`, the ledger, the questions log, `listComments` and `comment` (Task 7); the driver's pause sequence and `pendingEvent` handling (Task 8).
- Produces (the spec-start change lands here, together with the loop that uses it):
  - `specPresentGate` failures are all `ignore(reason)`; `NEEDS_SPEC` is removed.
  - `selectEligible(...)` returns `{ eligible, decisions, specProblems: Map<number, string> }`. A spec-present failure adds the issue to `eligible`, records its reason in `specProblems`, and still pushes the gate decision with its `ignore` result.
- Produces: `Scheduler.tick()` does the following, in order:
  1. Run the freshness, liveness and claim resumption steps as today, except that both skip any claim whose issue has a paused record in any phase (step 2 owns those), and liveness also skips a claim carrying `pendingEvent` or `pendingActions` (its next step applies them).
  2. Handle paused records, using the existing `listOpenIssues` call so it costs no extra listing. Records whose issue is active in this process are skipped. For each `listPaused` record:
     - **issue not open** (review focus 5): `removePaused`, and `removeClaim` when the record is `resuming`; log `paused-dropped`;
     - **phase `pausing`** (a crash mid-pause, review focus 8): when `question_comment_id` is null, adopt the bot comment whose body contains `questionMarker(record.nonce)` if there is one, otherwise post the question. A question comment with another nonce is never adopted. Then apply the labels, notify, set `phase: "paused"`, log `sent`, and `removeClaim`;
     - **phase `paused` with a claim on disk**: `removeClaim`;
     - **phase `resuming`**: finish the resume below from step 3, when a slot is free;
     - **`pausedDecision` returns `resume`**, and a slot is free:
       1. rewrite the record with `phase: "resuming"`, the answer and `reply_comment_id`;
       2. `appendQuestionLog` `answered` with both comment ids, unless `answeredEntry(paths, question_comment_id)` already exists;
       3. `ensureWorktree`, then write a claim with `state: record.state` (stage `paused`) and `pendingEvent: { type: "answered", answer, questionId: question_comment_id }`, unless a claim for the issue already exists;
       4. add `in-progress`, then remove `needs-decision`;
       5. `removePaused`;
       6. start the chain, before any shortlisted issue (AC-15). Its first `step()` applies the `answered` event (Task 8).

       Steps 3 to 6 are what the `resuming` case repeats; step 2's guard keeps the log to one `answered` line. With no free slot, the record stays and is retried next tick.
     - **`remind`**: comment `@<maintainer> Still waiting on your answer: <question>` on the issue, `notify({ issue, gate: "question-reminder", label: "needs-decision", text })`, rewrite the record with `reminded: true`, and log `reminded`;
     - **`wait`**: nothing.
  3. Build the shortlist with `SelectContext.claimed` = claimed issues ∪ paused-record issues. Shortlist claims use `initialChainState(issue.number, specProblems.get(issue.number) ?? null, await readLedger(paths, issue.number))`.
  4. Label decisions from the shortlist, now only `needs-design-stage`, are applied as today, once, because the `needs-` prefix skip then hides the issue.

  Reordering detail: today the loop lists open issues after resuming claims and only when a slot is free. Move the listing so it happens whenever paused records exist or a slot is free.

- [ ] **Step 1: Write the failing tests.**
  - **Gates and shortlist:** spec-present failures give `action: "ignore"`. An issue whose spec is missing is eligible, with `specProblems.get(n)` matching `/not found on main/` (AC-19). An issue with a paused record is not eligible even without `needs-decision`.
  - **Loop: spec start** (replaces "labels needs-spec"): an issue whose spec is missing is claimed, and its claim's `state.specProblem` matches `/not found on main/`. No label other than `in-progress` is added (AC-19).
  - **Loop: ledger seed:** with `escalations/7.json` holding `rescues: 1`, a new claim for 7 has `state.rescues === 1` (AC-7).
  - **Loop: resume.** Given a `paused/7.json` record, a maintainer comment with a higher id, one slot, and a priority-labelled issue 8 eligible. After `tick()` and the chain's first step:
    - `info.claimed` is `[7]`, and issue 8 is not claimed;
    - the label calls are `+in-progress` then `-needs-decision`;
    - the claim has no `pendingEvent`, `state.stage` equal to the record's `asking_stage` route (AC-18), and `state.answer` equal to the comment body;
    - the record is gone, and the log has one `answered` line with both comment ids.
  - **Loop: older comment:** a maintainer comment with a lower id than the question does not resume (review focus 1).
  - **Loop: crash mid-pause:** a `pausing` record with `question_comment_id: null` and the bot's question comment carrying its nonce already on the issue gets that comment's id, with no new comment posted. With only an earlier question comment carrying another nonce, a new comment is posted and the earlier one is not adopted. A `pausing` record with a claim still on disk ends with the claim removed and the claim not resumed by step 1 (review focus 8).
  - **Loop: crash mid-resume:** a `resuming` record with a claim already written (holding `pendingEvent`) and an `answered` line already logged produces no second claim write and no second `answered` line; the labels are applied, the record is removed, and the chain starts and applies the event (review focus 8).
  - **Loop: crash after the record is removed:** a claim with the paused state and `pendingEvent`, and no paused record, is not expired by liveness; step 1 starts it and its first step applies the event.
  - **Loop: reminder:** a 25-hour-old record with no reply posts one comment starting `@adam26davidson` and sends one `question-reminder` notification. A second `tick()` sends none (AC-16).
  - **Loop: closed issue:** a paused record whose issue is absent from the open-issue list is removed, and no claim is made (review focus 5).
  - **Loop: UI issue:** an issue with a `web-ui` spec and no design gets `needs-design-stage` once. A second tick, with the label now present, adds nothing and sends no notification (AC-20).
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/gates.test.ts tools/scheduler/test/shortlist.test.ts tools/scheduler/test/loop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `scheduler: missing specs start at the spec stage; resume paused issues on the maintainer's reply ahead of the shortlist; one reminder (spec 006 AC-7, AC-13, AC-15, AC-16, AC-19, AC-20)`.

---

### Task 10: Recorded end-to-end chains

**Files:**
- Modify: `tools/scheduler/test/e2e.test.ts`
- Possibly create: `tools/scheduler/test/helpers/e2e-routes.ts` (shared mock routes, if `e2e.test.ts` becomes repetitive)

**Interfaces:**
- Consumes: everything above; the e2e harness already in `e2e.test.ts` (`scripted`, `repoPair`, `mockGitHub`, `Scheduler`).

Ten chains (AC-28). Each drives `Scheduler.tick()` until the chain ends, then asserts the ordered `labelLog`, the `comments`, and the stage list in the adapter's `ran`:

| Chain | Scripted results | Asserts |
|---|---|---|
| rescue then merge | plan fails twice, then rescue plan ok, implement ok, review approve | `ran` ends `…plan, plan, plan, implement, review`; merged; `labelLog` = `+in-progress, -in-progress` |
| re-plan then merge | implement fails twice, rescue implement fails, plan ok, implement ok, approve | PR close PATCH, issue-branch DELETE; a `closed-pr` patch file; merged |
| spec revision then merge | as above, then the second implement also fails | spec stage in `revise` mode on `spec-<issue>`; spec PR 12 verified, reviewed with the `spec` profile, merged, `spec-<issue>` deleted; then plan, implement on `issue-<issue>` (review focus 7), merged |
| question paused, answered, recorded, merged | review escalate technical; check `send`; maintainer comment; fix adds `docs/decisions/0001-x.md` carrying the mark; review approve | comment headed `### Question for the maintainer` with `@adam26davidson` and the nonce marker; `+needs-decision`, `+in-progress`, `-needs-decision`; fix input contains the answer; merged |
| a reply that asks back, a follow-up, recorded, merged | review escalate technical; check `send`; maintainer comment "what does option 2 cost in RAM?"; resumed fix returns an `escalation` with the follow-up; maintainer comment "option 1"; fix adds the marked ADR; review approve | the question check ran once; two question comments; `needs-decision` added twice; no failed-run entry in the history, and `decideReturns`, `fixes` and the ledger counts unchanged by the follow-up; merged |
| decide_yourself then merge | review escalate technical; check `decide_yourself`; review approve | no `needs-decision`; review input contains the reasoning |
| capability question from implement | implement returns `escalation` kind `capability`; check `send`; maintainer comment; implement ok; approve | paused and resumed; resumed implement input contains the answer; no ADR required; merged |
| abandonment | every stage fails after spec revision | `+abandoned` before `-in-progress`; the abandonment comment has no `@`; issue left open; one finding queued |
| security finding fixed then merged | diff touches `agents/x.md`; security review with one finding; fix; security review approve | no `security-review` or `needs-human` label; two review runs with the security profile; merged |
| spec PR touching the charter (AC-22) | spec stage in `write` mode returns `revised` with a diff touching `docs/charter.md`; every fix keeps it | one fix with the violation; rescue fix; abandoned; no PUT to `/pulls/*/merge`; `docs/charter.md` on the mock remote's `main` unchanged |

- [ ] **Step 1: Write the ten tests**, one `it` each, named after the table rows with `(spec 006 AC-28)`.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/e2e.test.ts`. Expected: the new tests PASS. They are acceptance tests over finished code; a failure here is a bug in Tasks 4 to 9, so fix it in the owning module with a unit test first.
- [ ] **Step 3: Run** `pnpm test` and `pnpm -F @panelator/scheduler typecheck`. Expected: PASS and clean.
- [ ] **Step 4: Commit** `scheduler: recorded end-to-end chains for every escalation outcome (spec 006 AC-15, AC-22, AC-28)`.

---

### Task 11: Documents

**Files:**
- Modify: `docs/process-spec.md`, `specs/001-scheduler-core/spec.md`, `specs/README.md`

These edits are content, with no tests beyond the tree check of Task 3. Each states the new rule and cites spec 006 or the design, without restating its mechanics. `docs/delivery-system-design.md` needs no edit here: its `Parent:` line and `## Children` section land in Task 3, and its section 11 table already names the classification check under B.

- [ ] **Step 1: `docs/process-spec.md`.**
  - **Top:** a line linking `charter.md` as the document above this one, which wins where they conflict.
  - **Section 1, piece table:** a first row for the charter (the root: goals and limits, changed only by the maintainer), above the six pieces.
  - **Section 2, rewritten in full.** State the charter's goal: an agentic system that delivers autonomously, reaching the maintainer only for the questions of design section 3 (product decisions in its narrowed sense, large technical decisions with real uncertainty, what agents cannot do). Drop "reviewer of last resort", the "one gate" sentence and the autonomy-ladder framing that implies a human merge gate. Point to the design for how questions are checked and asked.
  - **Section 3, Spec row:** "agent drafts; checked by an agent against the grilling record (spec 006)".
  - **Section 4.2, step 3:** a possible design flaw becomes a question that goes through the design section 3 check (spec 006). It reaches the maintainer only when the check sends it; otherwise the agents decide and record it as an ADR in `docs/decisions/`.
  - **Section 4.5:** marked "Superseded by the delivery-system design section 9: the work ratio is a console parameter; the parameter store and the shortlist's use of it belong to spec C." The old text stays below the marker.
  - **Section 5:**
    - sensitive-path findings go to the fix loop (spec 006);
    - automation changes go through normal review; only the charter is locked, and the maintainer's recorded decisions are protected as design section 5 defines them;
    - firmware: "No promotion from beta to stable until spec G lands; then promotion is automatic, under G's criteria (design section 5)". The sentence "the one human release action" is removed.
  - **Section 7:** marked "Superseded by the delivery-system design section 7: storage and the metric set belong to spec D." The old text stays below the marker.
- [ ] **Step 2: `specs/001-scheduler-core/spec.md`.**
  - **Status line:** append "; amended by spec 006".
  - **Section 2:** "(spec 002)" for the shortlist becomes "(a later spec)", and the Telegram "(spec 003)" and filing agent "(spec 004)" become design specs A and C.
  - **Superseded items:** prefix AC-7 to AC-13, the section 5 `needs-human` rows and the section 8 rows that AC-1 to AC-23 of spec 006 replace with `Superseded by spec 006:`, leaving their text in place.
- [ ] **Step 3: `specs/README.md`.**
  - No maintainer approval for specs derived from an approved design.
  - Every spec carries `Parent:`, and its parent lists it under `## Children`.
  - The hierarchy rules of design section 10, in four sentences.
- [ ] **Step 4: Verify.** Run `pnpm test` and `pnpm -F @panelator/scheduler typecheck`; expected PASS and clean, including the tree check. Run `git diff --stat main -- docs/charter.md`; expected empty.
- [ ] **Step 5: Commit** `docs: process spec, spec 001 and the specs README follow spec 006`.

---

## Final check

- [ ] `pnpm test` from the repo root: all files pass. Paste the summary into the final message.
- [ ] `pnpm -F @panelator/scheduler typecheck`: no errors.
- [ ] `grep -rn "needs-human\|NEEDS_HUMAN\|NEEDS_SPEC\|NEEDS_CLARIFICATION\|securityFinding\|merge_blocked\|automationChangeGate\|closeIssue" tools/scheduler/src` prints nothing except `normalizeChainState`'s drop of `securityFinding`.
- [ ] `git diff --stat main -- docs/charter.md` prints nothing.
