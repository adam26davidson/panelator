# Spec 006: The chain runs to merge with no human stops — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every `needs-human` outcome in `tools/scheduler` with these steps, run by agents:
- rescue, re-plan, spec revision, then a recorded abandonment;
- a spec stage whose changes reach `main` through their own PR;
- a question check that decides whether a question reaches the maintainer, with a pause-and-resume over issue comments;
- security findings through the fix loop;
- the design hierarchy's `Parent:` and `Children` links, checked in `pnpm test`.

**Architecture:** The chain stays a pure state machine (`chain/machine.ts`). Escalation is one function, `escalate()`, that every exhausted bound calls, and its limits are constants in that module. The spec PR reuses the existing verify, review, fix and merge stages, with a `track: "spec"` flag on `ChainState`. A paused issue has no claim: its state lives in `paused/<issue>.json`, and the service loop resumes it when the maintainer comments.

**Tech Stack:** Node 26 (native `.ts`, `erasableSyntaxOnly`), TypeScript 7 typecheck, vitest 3, ajv 8, yaml 2, octokit, all as already used by `tools/scheduler`.

**Spec:** `specs/006-no-human-stops/spec.md` (AC-n below are its criteria). It amends `specs/001-scheduler-core/spec.md`; read section 4 of spec 006 for the chain table this plan implements. The design behind it is `docs/delivery-system-design.md`.

## Global Constraints

- `pnpm test` from the repo root passes before any task is called done; include its output in the final message (AGENTS.md).
- Work on branch `spec-006-impl` cut from `main`. Commit per task; do not push (AGENTS.md).
- TypeScript ESM, `erasableSyntaxOnly`: no `enum`, no parameter properties, no namespaces. Relative imports carry `.ts`.
- No test touches the network. GitHub is `test/helpers/mock-github.ts`; harnesses are fake adapters as in `test/driver.test.ts`.
- Escalation bounds are constants in `src/chain/machine.ts`, never config or stage definitions (AC-6): `MAX_FIXES = 2` (unchanged), `MAX_RESCUES = 1`, `MAX_REPLANS = 1`, `MAX_SPEC_REVISIONS = 1`, `MAX_DECIDE_RETURNS = 1`.
- Label names: `needs-decision` (paused, AC-12), `abandoned` (AC-5), `needs-design-stage` (AC-17). `needs-human`, `needs-spec`, `needs-clarification`, `needs-design` and `security-review` are no longer applied by any code path.
- Spec PR branch: `spec-<issue>`. Issue PR branch stays `issue-<issue>`.
- Question comment heading, exact: `Question for the maintainer`. Reminder after 24 hours, exactly once (AC-15).
- Model ids: rescue model `claude-fable-5-1`; question check primary `openai/gpt-6.1-sol` on pi, fallback `claude-fable-5-1`; spec stage `claude-fable-5-1`.
- `docs/charter.md` must never appear in this branch's diff (the spec does not list it, and the scope rule keeps it out).

## Review Focus

1. **A maintainer comment written before the question.** If the maintainer had commented earlier in the issue, that comment must not resume it. Only comments strictly after `asked_at` count. Pinned in Task 7.
2. **A spec PR that edits its parent design outside the `## Children` section.** This must be a scope violation, even though the parent file is otherwise allowed. Pinned in Task 4.
3. **A review result with `verdict: "escalate"` and no `escalation` object.** It must fail schema validation, so the stage is recorded as a failed run (and retried), not a crash in the machine. Pinned in Task 1.
4. **A spec stage result whose `spec_path` points outside `specs/`** (`../x`, `specs/../docs/charter.md`). The result must be refused as a failed run, and the issue body must not be edited. Pinned in Task 8.
5. **A paused issue that the maintainer closes instead of answering.** Its `paused/` record must be dropped on the next tick and never resumed. Pinned in Task 9.

## File structure

```
tools/scheduler/src/
  types.ts                  + SpecMode, Question, SpecResult, QuestionCheckResult; AgentStageName + "spec" | "question-check"; StageDefinition.independent
  stages/prompt.ts          + history, question, answer, mode, decide_input, spec_problem placeholders
  stages/definition.ts      stage names, `independent`
  runner/retry.ts           independent fallback
  config.ts                 + rescue_model
  spec/parse.ts             + parent, parseChildren()
  gates/design-tree.ts      NEW: checkDesignTree(), loadDesignTree()
  gates/spec-present.ts     parent checks; returns ignore-kind failures
  gates/spec-scope.ts       NEW: specScopeGate()
  gates/ui-design.ts        needs-design-stage
  gates/ready.ts, fix-loop.ts   no labels
  gates/automation-change.ts    DELETED
  shortlist/select.ts       spec-start eligibility, no automation gate
  chain/types.ts, machine.ts    new stages, escalate(), spec track, question flow
  chain/driver.ts           new actions, rescue model, spec track, new stage inputs
  github/client.ts          + listComments, closeIssue, closePullRequest, deleteBranch, setIssueBody
  state/paused.ts           NEW: paused records, pausedDecision()
  state/paths.ts            + paused dir
  service/loop.ts           resume paused, reminders, spec-start claims
tools/scheduler/test/       chain, gates, shortlist, driver, loop, e2e, schema, stages, retry, spec, design-tree (NEW), paused (NEW), client
agents/stages/spec.md, question-check.md      NEW
agents/profiles/spec/                          NEW
agents/profiles/security/                      charter rule, fix-loop wording
agents/sensitive-paths.txt, agents/scheduler.yaml
schemas/scheduler/          question, spec-result, question-check-result, paused NEW; review-result, stage-input, claim amended
specs/00{1..6}-*/spec.md, specs/README.md, docs/process-spec.md, docs/product-spec.md, docs/delivery-system-design.md
```

---

### Task 1: Result shapes, schemas and prompt placeholders

**Files:**
- Modify: `tools/scheduler/src/types.ts`, `tools/scheduler/src/stages/prompt.ts`
- Create: `schemas/scheduler/question.json`, `schemas/scheduler/spec-result.json`, `schemas/scheduler/question-check-result.json`, `schemas/scheduler/paused.json`
- Modify: `schemas/scheduler/review-result.json`, `schemas/scheduler/stage-input.json`
- Test: `tools/scheduler/test/schema.test.ts`, `tools/scheduler/test/stages.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  ```ts
  export type AgentStageName = "plan" | "implement" | "review" | "fix" | "spec" | "question-check";
  export type SpecMode = "write" | "answer" | "revise" | "decide";
  export interface Question { kind: "product" | "technical" | "capability" | "other"; question: string; options: { label: string; cost: string }[]; recommendation: string }
  export interface SpecResult { verdict: "revised" | "question"; spec_path?: string; pr_number?: number; head_sha?: string; question?: Question; findings?: Finding[] }
  export interface QuestionCheckResult { verdict: "send" | "decide_yourself"; reasoning: string; findings?: Finding[] }
  // ReviewResult gains: escalation?: Question
  ```
- Produces (in `src/stages/prompt.ts`): `StageInput` gains optional `history?: string; question?: string; answer?: string; mode?: SpecMode; decide_input?: string; spec_problem?: string`. `renderPrompt` maps the placeholders `{{history}} {{question}} {{answer}} {{mode}} {{decide_input}} {{spec_problem}}`. Each renders `(none)` when absent, as the existing ones do.
- Schema names for `validate(name, data)`: `question`, `spec-result`, `question-check-result`, `paused`.

- [ ] **Step 1: Write the failing tests** in `test/schema.test.ts`:

```ts
const q = { kind: "technical", question: "WAMR or wasm3?", options: [{ label: "WAMR", cost: "keeps AOT" }, { label: "wasm3", cost: "slower" }], recommendation: "WAMR" };
it("review escalate requires an escalation object (AC-7, review focus 3)", () => {
  expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(false);
  expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [], escalation: q }).ok).toBe(true);
  expect(validate("review-result", { verdict: "approve", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(true);
});
it("spec-result: revised needs spec_path, pr_number, head_sha; question needs question (AC-18)", () => {
  expect(validate("spec-result", { verdict: "revised", spec_path: "specs/010-x/spec.md", pr_number: 4, head_sha: "a".repeat(40) }).ok).toBe(true);
  expect(validate("spec-result", { verdict: "revised", pr_number: 4, head_sha: "a".repeat(40) }).ok).toBe(false);
  expect(validate("spec-result", { verdict: "question" }).ok).toBe(false);
  expect(validate("spec-result", { verdict: "question", question: q }).ok).toBe(true);
});
it("question-check-result is send or decide_yourself with reasoning (AC-11)", () => {
  expect(validate("question-check-result", { verdict: "send", reasoning: "r" }).ok).toBe(true);
  expect(validate("question-check-result", { verdict: "maybe", reasoning: "r" }).ok).toBe(false);
  expect(validate("question-check-result", { verdict: "send" }).ok).toBe(false);
});
it("question options need label and cost", () => {
  expect(validate("question", { ...q, options: [{ label: "x" }] }).ok).toBe(false);
});
```

And in `test/stages.test.ts`: `renderPrompt("{{mode}}|{{history}}|{{answer}}", { ...minimalInput, mode: "revise", history: "h" })` returns `"revise|h|(none)"`.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/schema.test.ts tools/scheduler/test/stages.test.ts`. Expected: FAIL (unknown schemas, unknown placeholder).

- [ ] **Step 3: Implement.**
  - **New schemas.** Follow the shape of the existing schema files. `spec-result` uses `if/then`: `revised` requires `spec_path` (pattern `^specs/[0-9]{3}-[a-z0-9-]+/spec\.md$`), `pr_number` and `head_sha` (40 hex); `question` requires `question` (`$ref: question.json`).
  - **`review-result.json`.** Gains `escalation: { $ref: question.json }` and `if verdict=escalate then required [escalation]`.
  - **`stage-input.json`.** Gains the six optional string fields; `mode` takes the enum of `SpecMode`.
  - **`paused.json`.** Describes the record of Task 7: `issue`, `state` (object), `question` (`$ref`), `asking_stage` (enum `review`/`spec`), `asked_at` (date-time), `reminded` (boolean). All required.
  - **Loading.** Check how `src/schema/validate.ts` loads the schema directory. If it lists file names, add the new ones.

- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm test`; the typecheck may show `AgentStageName` switch gaps, which Task 2 and Task 5 close. If the suite fails only on exhaustiveness in `driver.ts`, add `default: throw` arms as needed to keep it green.

- [ ] **Step 5: Commit** `scheduler: result shapes for the spec stage, question check and review escalation (spec 006 AC-7, AC-11, AC-18)`.

---

### Task 2: Stage definitions, independent fallback, rescue model, profiles

**Files:**
- Modify: `tools/scheduler/src/stages/definition.ts`, `tools/scheduler/src/runner/retry.ts`, `tools/scheduler/src/config.ts`
- Create: `agents/stages/spec.md`, `agents/stages/question-check.md`, `agents/profiles/spec/profile.yaml`, `agents/profiles/spec/instructions.md`, `agents/profiles/spec/review-criteria.md`
- Modify: `agents/scheduler.yaml`
- Create: `tools/scheduler/test/fixtures/streams/pi-429.jsonl`
- Test: `tools/scheduler/test/stages.test.ts`, `tools/scheduler/test/retry.test.ts`, `tools/scheduler/test/config.test.ts`, `tools/scheduler/test/profiles.test.ts`, `tools/scheduler/test/adapters-pi.test.ts`

**Interfaces:**
- Consumes: `AgentStageName`, `SpecMode` from Task 1.
- Produces:
  - `StageDefinition.independent?: boolean`.
  - `loadStageDefinitions(dir)` requires all six stages.
  - `Config.rescue_model: string`, default `"claude-fable-5-1"`.
  - `retryDecision(def, judgement, costSoFar, limit)`: for `def.independent && def.fallback` on API status 429, it returns `{ kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) }`. That holds regardless of tier and cost (AC-22).

- [ ] **Step 1: Write the failing tests.**
  - `stages.test.ts`:
    - `parseStageDefinition` accepts a strong-tier stage with `fallback` when `independent: true`;
    - it still throws `/may not name a fallback/` without `independent`;
    - `loadStageDefinitions(agentsDir)` returns keys `plan implement review fix spec question-check`;
    - `defs["question-check"]` has `harness: "pi"`, `model: "openai/gpt-6.1-sol"`, `independent: true`, `fallback: "claude-fable-5-1"`;
    - `defs.spec` has `tier: "strong"`, `output: "spec-result"`.
  - `retry.test.ts`:
    - an independent strong def with a 429 judgement and `costSoFar` 99 (above the limit) returns the fallback;
    - a non-independent strong def returns `postpone`, as today.
  - `adapters-pi.test.ts`: the new `pi-429.jsonl` fixture is judged `failed` with `apiErrorStatus: 429`. Build the fixture from `pi-error-exit0.jsonl`, with an assistant error message carrying `429` the way the regex at `src/adapters/pi.ts:66` reads it.
  - `config.test.ts`:
    - `loadConfig(defaultConfigPath).rescue_model` is `"claude-fable-5-1"`;
    - a config without the key defaults to the same.
  - `profiles.test.ts`: `resolveProfile(agentsDir, "spec")` resolves, with non-empty `reviewCriteria`.

- [ ] **Step 2: Run** these test files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`definition.ts` and `retry.ts`.**
    - `STAGES` gains the two names.
    - `independent` is parsed as a boolean.
    - The strong-tier fallback check becomes `fallback && tier === "strong" && !independent`.
    - `retryDecision` checks `independent` before the strong-tier postpone.
  - **`agents/stages/spec.md`.**
    - Frontmatter: `harness: claude`, `model: claude-fable-5-1`, `tier: strong`, `effort: high`, `bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }`, `worktree: issue`, `profile: spec`, `input: stage-input`, `output: spec-result`.
    - The prompt states each mode (`{{mode}}`):
      - `write`: write or complete the spec named by the problem `{{spec_problem}}`;
      - `answer`: answer the plan's questions in `{{spec_problem}}`, writing technical answers into the spec marked as the agent's call;
      - `revise`: change the spec so the history `{{history}}` stops failing;
      - `decide`: the check returned `{{decide_input}}`, so pick an approach and write it in.
    - The prompt also gives:
      - the section 3 rule, quoted from the design: only product, uncertain large technical, or capability questions may be returned as `question`;
      - the branch rule: create `spec-<issue>` from `origin/main`, edit only the spec's directory, `docs/designs/`, and the `## Children` section of the parent design;
      - the field set, including `Parent:`;
      - push, then open the PR into `main` with `gh`;
      - write the result to `{{result_path}}`, using the exact JSON shape;
      - with `{{answer}}` present, use the maintainer's answer.
  - **`agents/stages/question-check.md`.**
    - Frontmatter: `harness: pi`, `model: openai/gpt-6.1-sol`, `fallback: claude-fable-5-1`, `independent: true`, `tier: strong`, `effort: high`, `bounds: { timeout_min: 15, max_turns: 40, max_cost_usd: 2 }`, `worktree: issue`, `profile: none`, `output: question-check-result`.
    - The prompt quotes design section 3 in full (the three kinds, the definitions of "large" and "real uncertainty"), then `{{question}}`, `{{spec}}` and `{{history}}`.
    - It asks for `send` only when the question is one of the three kinds and the agent's own investigation could not settle it; `decide_yourself` otherwise, with `reasoning` the asking agent can act on.
  - **`agents/profiles/spec/`.** Mirror `profiles/security/`. `tools: [Read, Glob, Grep, Bash, Edit, Write]`. `review-criteria.md` has the AC-18 rules, numbered:
    1. fits the parent design;
    2. fits the issue body;
    3. has the spec field set and a `Parent:` line, and the parent lists it;
    4. decides no section 3 question itself;
    5. edits nothing outside the allowed paths.
  - **`agents/scheduler.yaml`.** Add `rescue_model: claude-fable-5-1`.

- [ ] **Step 4: Run** the test files, then `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit** `scheduler: spec and question-check stage definitions, independent fallback, rescue model (spec 006 AC-18, AC-22)`.

---

### Task 3: Parent and Children links and the design-tree check

**Files:**
- Modify: `tools/scheduler/src/spec/parse.ts`
- Create: `tools/scheduler/src/gates/design-tree.ts`, `tools/scheduler/test/design-tree.test.ts`
- Modify (content): `specs/001-scheduler-core/spec.md` … `specs/006-no-human-stops/spec.md` (add `Parent:`), `docs/delivery-system-design.md` (add `Parent:` and `## Children`), `docs/product-spec.md` (add `Parent:` and an empty `## Children`)
- Test: `tools/scheduler/test/spec.test.ts`

**Interfaces:**
- Produces:
  - `ParsedSpec.parent: string | null`, from a line `^Parent:\s*(\S+)$` anywhere in the status block. Its absence is not added to `missing`; the gate (Task 4) owns that.
  - `parseChildren(text: string): string[] | null`: the backticked or bare repo-relative paths on `- ` bullet lines under a `## Children` heading (numbered or not, same matching as other headings); `null` when the heading is absent, `[]` when empty.
  - `checkDesignTree(files: Map<string, string>): string[]`: error strings, empty when valid.
  - `loadDesignTree(root: string): Map<string, string>`: reads `docs/charter.md`, `docs/product-spec.md`, `docs/delivery-system-design.md`, `docs/designs/*.md` and `specs/*/spec.md` under `root`.
  - Constants: `ROOT = "docs/charter.md"`, `TOP_DESIGNS = ["docs/product-spec.md", "docs/delivery-system-design.md"]`.

Rules `checkDesignTree` enforces (AC-20):
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
it("the repository's own tree is valid (AC-20, AC-21)", () => expect(checkDesignTree(loadDesignTree(repoRoot))).toEqual([]));
```

In `test/spec.test.ts`:
- `parseSpec("Status: x\nParent: docs/a.md\n...").parent === "docs/a.md"`;
- `parseChildren("## Children\n- \`specs/1/spec.md\`\n- specs/2/spec.md\n")` returns both paths;
- `parseChildren` returns `null` without the heading.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/design-tree.test.ts tools/scheduler/test/spec.test.ts`. Expected: FAIL. The repo test fails because no `Parent:` lines exist yet.

- [ ] **Step 3: Implement** `parse.ts` additions and `design-tree.ts`. Error strings name the file and the rule, for example `specs/011-b/spec.md: parent docs/designs/nope.md does not exist`.

- [ ] **Step 4: Edit the documents (AC-21).**
  - **Specs.** Add `Parent: docs/delivery-system-design.md` after the `Class:` line in specs 001 to 005. Spec 006 already has it.
  - **`docs/delivery-system-design.md`.** Add `Parent: docs/charter.md` to the status paragraph as its own line. Append a final `## Children` section listing the six spec paths.
  - **`docs/product-spec.md`.** Add `Parent: docs/charter.md` as its own line under the status, and an empty `## Children` section at the end.

- [ ] **Step 5: Run** the tests again, then `pnpm test`. Expected: PASS.

- [ ] **Step 6: Commit** `scheduler: Parent and Children links with a design-tree check over the repository (spec 006 AC-20, AC-21)`.

---

### Task 4: Gates and shortlist

**Files:**
- Modify: `tools/scheduler/src/gates/spec-present.ts`, `ui-design.ts`, `ready.ts`, `fix-loop.ts`, `index.ts`
- Delete: `tools/scheduler/src/gates/automation-change.ts`
- Create: `tools/scheduler/src/gates/spec-scope.ts`
- Modify: `tools/scheduler/src/shortlist/select.ts`, `tools/scheduler/src/shortlist/fetch.ts`
- Modify (content): `agents/sensitive-paths.txt`, `agents/profiles/security/review-criteria.md`, `agents/profiles/security/instructions.md`
- Modify: `tools/scheduler/test/fixtures/specs/good-backend.md`, `good-webui.md` (add `Parent: docs/top.md`)
- Test: `tools/scheduler/test/gates.test.ts`, `tools/scheduler/test/shortlist.test.ts`, `tools/scheduler/test/profiles.test.ts`

**Interfaces:**
- Consumes: `parseSpec().parent`, `parseChildren()` (Task 3).
- Produces:
  - `specPresentGate(issue: IssueData, specText: string | null, readRepoFile: (path: string) => string | null): GateResult`. Every failure is `ignore(reason)`; `NEEDS_SPEC` is removed. Parent checks (AC-19): there is a `Parent:` line; `readRepoFile(parent) !== null`; `parseChildren(parentText)` includes the spec path.
  - `uiDesignGate(...)`: labels `NEEDS_DESIGN_STAGE = "needs-design-stage"`. The reason is `"spec E will provide the design stage: " + problems`.
  - `readyGate(plan)`: returns `ignore(questionsText)` on `spec_gap`; `NEEDS_CLARIFICATION` is removed.
  - `fixLoopGate(fixes)`: returns `ignore(...)` at the bound; `NEEDS_HUMAN` is removed.
  - `specScopeGate(diffFiles: string[], specPath: string, parentPath: string, parentBefore: string, parentAfter: string): ScopeResult`. Allowed files: anything under `dirname(specPath) + "/"`, anything under `docs/designs/`, and `parentPath` only when `stripChildren(parentBefore) === stripChildren(parentAfter)` (the text with the `## Children` section removed).
  - `SelectContext.readSpec` is reused as `readRepoFile`.
  - `selectEligible(...)` returns `{ eligible, decisions, specProblems: Map<number, string> }`. A spec-present failure adds the issue to `eligible` and records its reason in `specProblems`, and the gate decision is still pushed with its `ignore` result. The automation-change step and the `SECURITY_REVIEW_LABEL` skip are removed.

- [ ] **Step 1: Write the failing tests** in `test/gates.test.ts` and `test/shortlist.test.ts`.
  - **Spec-present.**
    - Fails, with reasons matching `/Parent/`:
      - `specPresentGate(issue, specWithoutParent, read)` gives `{ ok: false, action: "ignore" }`;
      - a parent that is absent from `read`;
      - a parent whose Children omit the spec.
    - Passes when the parent lists it.
  - **UI design.** `uiDesignGate(webuiSpec, [])` gives `{ ok: false, action: "label", label: "needs-design-stage" }`.
  - **Ready and fix loop.** `readyGate(spec_gap)` and `fixLoopGate(2)` give `action: "ignore"`.
  - **Spec scope** (review focus 2):
    - a diff `["specs/010-x/spec.md", "docs/designs/a.md", "docs/top.md"]` passes when `docs/top.md` changed only under `## Children`;
    - the same diff fails with `docs/top.md: changes outside its Children section` when a line above Children changed;
    - `["tools/scheduler/src/x.ts"]` fails.
  - **Charter in the sensitive list and security criteria (AC-9).**
    - `readSensitiveGlobs(agentsDir)` contains `docs/charter.md`;
    - `isSensitive(["docs/charter.md"], globs)` is non-empty;
    - `readFileSync(agents/profiles/security/review-criteria.md)` matches `/docs\/charter\.md/` and `/revert/`;
    - `instructions.md` no longer matches `/until the maintainer looks/`.
  - **Shortlist.**
    - A bot-authored validated issue whose spec lists `tools/scheduler/` is eligible (AC-10).
    - An issue whose spec is missing is eligible with `specProblems.get(n)` matching `/not found on main/` (AC-16).
    - An issue labelled `needs-decision` is skipped.
    - An issue labelled `needs-design-stage` is skipped.
  - **Old tests.** Delete the automation-change gate's tests and update the old `needs-human`/`needs-spec` label assertions to the new outcomes.

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/gates.test.ts tools/scheduler/test/shortlist.test.ts tools/scheduler/test/profiles.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the gate and select changes.
  - **Content files.**
    - Add `docs/charter.md` to `agents/sensitive-paths.txt` as its own line, with a comment `# the charter: any change is a finding (spec 006 AC-9)`.
    - Add a numbered criterion to `review-criteria.md`: "Any change to `docs/charter.md` is a finding. The scenario is the edit itself, and the fix is to revert it; only the maintainer changes the charter."
    - In `instructions.md`, replace "Any finding blocks merge until the maintainer looks" with "Any finding sends the change back to the fix loop".
  - **Fixtures and helpers.**
    - Add `Parent: docs/top.md` to `good-backend.md` and `good-webui.md`.
    - Wherever tests build a repo or `readSpec` from those fixtures (`test/shortlist.test.ts`, `test/loop.test.ts`, `test/e2e.test.ts`, `test/driver.test.ts`), add `docs/top.md` with `## Children` listing the fixture's spec path. Make one helper in `test/helpers/repo-pair.ts`, `withTopDesign(files, specPath)`, and use it in all four.

- [ ] **Step 4: Run** the tests, then `pnpm test`. Expected: PASS. `loop.test.ts` "labels needs-spec" changes in Task 9; until then mark it `it.todo` with that note.

- [ ] **Step 5: Commit** `scheduler: spec gaps and missing specs route to the spec stage; charter on the sensitive list; no automation gate (spec 006 AC-9, AC-10, AC-16, AC-17, AC-19)`.

---

### Task 5: Chain machine — escalation path and security findings

**Files:**
- Modify: `tools/scheduler/src/chain/types.ts`, `tools/scheduler/src/chain/machine.ts`, `schemas/scheduler/claim.json`
- Test: `tools/scheduler/test/chain.test.ts`

**Interfaces:**
- Produces (`chain/types.ts`):
  ```ts
  export type ChainStage = "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge" | "spec" | "question-check"
    | "done" | "released" | "waiting" | "paused" | "abandoned";
  // ChainState: remove securityFinding; add
  track: "issue" | "spec"; rescues: number; replans: number; specRevisions: number; decideReturns: number;
  rescueRun: boolean; history: string[]; specMode: SpecMode | null; specProblem: string | null;
  question: Question | null; askingStage: "review" | "spec" | null; answer: string | null; decideInput: string | null;
  // ChainEvent: remove merge_blocked; add
  | { type: "stage_ok"; stage: "spec"; result: SpecResult }
  | { type: "stage_ok"; stage: "question-check"; result: QuestionCheckResult }
  | { type: "answered"; answer: string }
  // Action: run_stage gains rescue?: true; mode?: SpecMode. New:
  | { type: "close_pr"; comment: string }
  | { type: "close_issue" }
  | { type: "finding"; stage: AgentStageName; finding: Finding }
  | { type: "pause"; question: Question; asking: "review" | "spec" }
  ```
- Produces (`machine.ts`):
  - `initialChainState(issue: number, specProblem: string | null = null)`;
  - constants `MAX_RESCUES`, `MAX_REPLANS`, `MAX_SPEC_REVISIONS`, `MAX_DECIDE_RETURNS` (all `1`), `ABANDONED_LABEL = "abandoned"`, `NEEDS_DECISION_LABEL = "needs-decision"`, `HISTORY_ENTRY_MAX = 4000`.

**The `escalate(state, stuck, reason)` rule** (spec section 4). `stuck` is the stage whose bound was hit. Append `${stuck}: ${reason}` to `history`, truncated to `HISTORY_ENTRY_MAX` characters, then:
1. If `state.track === "spec"`, abandon.
2. If `rescues < MAX_RESCUES`, `run(stuck)` with `rescue: true`, `rescueRun: true`, `rescues + 1`, attempt 1. For a stuck `fix` (fix-loop exhaustion or a failed fix), `fixInput = reason`. For a stuck `review` with an escalation of kind `other`, run `fix` with the escalation text as `fixInput`.
3. If `replans < MAX_REPLANS`, emit `close_pr` (when `pr`) with comment `"Closed by the scheduler to re-plan: " + reason`. The new state has `pr: null`, `plan: null`, `fixes`, `scopeViolations`, `planFailures`, `implementFailures` all 0, `replans + 1`, then `run("plan")`.
4. If `specRevisions < MAX_SPEC_REVISIONS`, emit `close_pr` (when `pr`), set `pr: null` and `specRevisions + 1`, then `run("spec", { mode: "revise" })`.
5. Otherwise, abandon. Actions in order:
   - `close_pr` (when `pr`);
   - `comment` with the history;
   - `label` add `abandoned`, remove `in-progress`;
   - `close_issue`;
   - `finding` with stage `stuck`, `what: "issue abandoned after the escalation path"`, `where: "issue #N"`, `evidence` the joined history, `noticed_how: "scheduler escalation"`;
   - `notify` with gate `abandoned` and label `abandoned`;
   - `done`.

   The stage is `abandoned`.

**When `escalate` replaces `needsHuman`:**
- every current `needsHuman` call;
- `toFix` at the fix bound;
- a `stage_failed` while `rescueRun` is set: the rescue run failed, so escalate again, without the usual one-retry;
- a `stage_failed` of `spec`, after one retry.

`stage_ok` of any stage clears `rescueRun`.

**Security** (AC-8): in `review`, findings with `state.sensitive || event.security` go to `toFix` with the findings text. Without findings, `approve` merges. The `securityFinding` hold and the `merge_blocked` event are gone.

- [ ] **Step 1: Rewrite `test/chain.test.ts`.** Keep the happy path; replace every `needs-human` test.

```ts
it("plan failing twice runs a rescue plan with the history (AC-1)", () => {
  const r = transition(at("plan", { planFailures: 1 }), { type: "stage_failed", stage: "plan", reason: "boom" });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1, rescue: true }]);
  expect(r.state).toMatchObject({ rescues: 1, rescueRun: true, history: ["plan: plan failed twice: boom"] });
});
it("fix loop exhaustion rescues with a fix run (AC-1)", () => { /* review changes_requested at fixes: 2 -> run_stage fix, rescue: true, fixInput contains "Review requested changes" */ });
it("a failed rescue re-plans: closes the PR, resets counters, plans with history (AC-2)", () => {
  const s = at("implement", { rescueRun: true, rescues: 1, pr: { number: 3, head_sha: "b".repeat(40) }, fixes: 2, implementFailures: 1 });
  const r = transition(s, { type: "stage_failed", stage: "implement", reason: "x" });
  expect(r.actions[0]).toEqual({ type: "close_pr", comment: expect.stringContaining("re-plan") });
  expect(r.actions.at(-1)).toEqual({ type: "run_stage", stage: "plan", attempt: 1 });
  expect(r.state).toMatchObject({ pr: null, plan: null, fixes: 0, implementFailures: 0, replans: 1 });
});
it("after a re-plan the next bound revises the spec (AC-3)", () => { /* rescues 1, replans 1 -> run_stage spec, mode revise, specRevisions 1 */ });
it("after a spec revision the next bound abandons, in order (AC-5)", () => {
  const r = transition(at("fix", { rescues: 1, replans: 1, specRevisions: 1, pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "stage_failed", stage: "fix", reason: "x" });
  expect(r.actions.map((a) => a.type)).toEqual(["close_pr", "comment", "label", "close_issue", "finding", "notify", "done"]);
  expect(r.actions[2]).toEqual({ type: "label", add: ["abandoned"], remove: ["in-progress"] });
  expect(r.state.stage).toBe("abandoned");
});
it("on the spec track any bound abandons (AC-5)", () => { /* track spec, fixes 2, changes_requested -> abandoned */ });
it("security findings go to fix, approval merges, no labels (AC-8)", () => {
  const r = transition(at("review", { sensitive: true }), { type: "stage_ok", stage: "review", result: changes, security: true });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("AC-1") }]);
  const m = transition(at("review", { sensitive: true }), { type: "stage_ok", stage: "review", result: approve, security: true });
  expect(m.actions).toEqual([{ type: "merge" }]);
});
it("the escalation bounds are 1 each and MAX_FIXES is 2 (AC-6)", () => {
  expect([MAX_RESCUES, MAX_REPLANS, MAX_SPEC_REVISIONS, MAX_DECIDE_RETURNS, MAX_FIXES]).toEqual([1, 1, 1, 1, 2]);
});
it("no transition yields needs-human (AC-23)", () => {
  // Table: for each ChainStage x each event shape from a fixture list, call transition inside try/catch (invalid throws are fine);
  // collect every resulting state.stage and every label action; assert none equals or adds "needs-human".
});
```

- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/chain.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the types, `escalate`, the replaced call sites, the security change, and `claim.json`'s `state` properties to match `ChainState`.

- [ ] **Step 4: Run** the chain tests. Expected: PASS. `driver.ts` may not typecheck until Task 8, because it uses the removed `merge_blocked`/`SECURITY_REVIEW_LABEL` and new stages. Make the minimal edits that keep `pnpm test` green: drop the security-label read in `mergeEvent`; add `"abandoned", "paused"` to `ENDED` and remove `"needs-human"`. Driver tests asserting `needs-human` move to `it.todo("spec 006 Task 8: …")`.

- [ ] **Step 5: Commit** `scheduler: rescue, re-plan, spec revision, abandonment in place of needs-human; security findings to the fix loop (spec 006 AC-1 to AC-6, AC-8, AC-23)`.

---

### Task 6: Chain machine — spec stage, spec track, question check, pause

**Files:**
- Modify: `tools/scheduler/src/chain/machine.ts`
- Test: `tools/scheduler/test/chain.test.ts`

**Interfaces:**
- Consumes: Task 5's types and `escalate`.
- Produces these transitions (spec section 4 rows):
  - **`claimed`, `start`:** with `specProblem` set, run `spec` with `mode: "write"` (`specMode: "write"`); otherwise run `plan`.
  - **`plan`, `spec_gap`:** set `specProblem` to the `readyGate` reason, then run `spec` with `mode: "answer"`.
  - **`spec`, `stage_ok`, `revised`:**
    - the new state is `track: "spec"`, `pr: { number, head_sha }`, `fixes: 0`, `scopeViolations: 0`, `stage: "verify"`;
    - actions: `[{ type: "verify" }]`;
    - `specMode`, `decideInput` and `answer` are cleared.
  - **`spec`, `question`:**
    - with kind `other`, the stage behaves as if the check returned `decide_yourself` with reasoning `"kind other is not a question for the maintainer"`;
    - otherwise the state gets `question`, `askingStage: "spec"`, and `run("question-check")` follows.
    - In `decide` mode a `question` verdict is a failed run: `stage_failed` handling (one retry, then `escalate`).
  - **`review`, `stage_ok`, `escalate`:**
    - with kind `other`, `escalate(state, "review", "review escalated: " + question)`;
    - otherwise `question`, `askingStage: "review"`, then `run("question-check")`.
    - When `state.decideInput` is set, a review `escalate` is a failed run.
  - **`question-check`, `send`:** state `stage: "paused"`. Actions:
    - `comment` with `formatQuestion(question)`;
    - `label` add `needs-decision`, remove `in-progress`;
    - `notify` with gate `question` and label `needs-decision`;
    - `pause`.
  - **`question-check`, `decide_yourself`:** increment `decideReturns`. If it exceeds `MAX_DECIDE_RETURNS`, `escalate(state, asking, "decide_yourself twice: " + reasoning)`. Otherwise run the asking stage with `decideInput = reasoning`: for `spec`, `mode: "decide"`; for `review`, the security profile when sensitive, as today.
  - **`paused`, `answered`:** set `answer`, clear `question`, `stage = askingStage`; run it (spec keeps its `specMode`).
  - **`merge`, `merged` on `track: "spec"`:** state `track: "issue"`, `pr: null`, `plan: null`, the stage counters 0, `specProblem: null`, `stage: "plan"`, actions `[{ type: "run_stage", stage: "plan", attempt: 1 }]`. Not `done`.
- Produces `formatQuestion(q: Question): string`. Exact first line: `### Question for the maintainer`, then the question, a numbered list of `label — cost`, `Recommendation: …`, and the closing line `Reply in a comment on this issue; the scheduler resumes on your reply.`

- [ ] **Step 1: Write the failing tests** in `test/chain.test.ts`:

```ts
it("a claimed issue with a spec problem starts at the spec stage in write mode (AC-16)", () => {
  const r = transition(initialChainState(1, "specs/010-x/spec.md not found on main"), { type: "start" });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1, mode: "write" }]);
});
it("spec_gap goes to the spec stage in answer mode, with no label (AC-16)", () => { /* actions have no label; mode answer; specProblem contains Q1 */ });
it("a revised spec goes through verify on the spec track, then back to plan after merge (AC-4)", () => {
  let r = transition(at("spec", { specMode: "revise" }), { type: "stage_ok", stage: "spec", result: { verdict: "revised", spec_path: "specs/010-x/spec.md", pr_number: 8, head_sha: "c".repeat(40) } });
  expect(r.state).toMatchObject({ track: "spec", stage: "verify", pr: { number: 8 } });
  r = transition({ ...r.state, stage: "merge" }, { type: "merge_result", status: "merged" });
  expect(r.state).toMatchObject({ track: "issue", stage: "plan", pr: null });
  expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
});
it("a review escalation of kind technical goes to the question check (AC-7, AC-11)", () => { /* askingStage review, run_stage question-check */ });
it("send pauses: comment, needs-decision label, notify, pause (AC-12)", () => {
  const r = transition(at("question-check", { question: q, askingStage: "spec" }), { type: "stage_ok", stage: "question-check", result: { verdict: "send", reasoning: "r" } });
  expect(r.actions.map((a) => a.type)).toEqual(["comment", "label", "notify", "pause"]);
  expect((r.actions[0] as { text: string }).text.split("\n")[0]).toBe("### Question for the maintainer");
  expect(r.state.stage).toBe("paused");
});
it("decide_yourself reruns the asker in decide mode; the second one escalates (AC-13)", () => { /* first -> run spec mode decide with decideInput; second -> escalate (rescue run) */ });
it("a question verdict in decide mode counts as a failed run (AC-13)", () => { /* stage_ok spec question with specMode decide -> retry spec, then escalate */ });
it("answered resumes the asking stage with the answer (AC-14)", () => {
  const r = transition(at("paused", { question: q, askingStage: "review" }), { type: "answered", answer: "WAMR" });
  expect(r.state).toMatchObject({ stage: "review", answer: "WAMR", question: null });
});
```

- [ ] **Step 2: Run** the chain tests. Expected: FAIL.
- [ ] **Step 3: Implement** the transitions and `formatQuestion`.
- [ ] **Step 4: Run** the chain tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `scheduler: spec stage, spec track, question check and pause in the chain (spec 006 AC-4, AC-7, AC-11 to AC-14, AC-16)`.

---

### Task 7: Paused records and the GitHub calls they need

**Files:**
- Create: `tools/scheduler/src/state/paused.ts`, `tools/scheduler/test/paused.test.ts`
- Modify: `tools/scheduler/src/state/paths.ts`, `tools/scheduler/src/github/client.ts`
- Test: `tools/scheduler/test/client.test.ts`, `tools/scheduler/test/state.test.ts`

**Interfaces:**
- Produces (`state/paused.ts`):
  ```ts
  export interface PausedRecord { issue: number; state: ChainState; question: Question; asking_stage: "review" | "spec"; asked_at: string; reminded: boolean }
  export const REMINDER_AFTER_H = 24;
  export async function writePaused(p: StatePaths, r: PausedRecord): Promise<void>   // validates against "paused", atomic write like writeClaim
  export async function listPaused(p: StatePaths): Promise<PausedRecord[]>
  export async function removePaused(p: StatePaths, issue: number): Promise<void>
  export interface IssueComment { author: string; at: string; body: string }
  export function pausedDecision(r: PausedRecord, comments: IssueComment[], maintainer: string, now: Date):
    { kind: "resume"; answer: string } | { kind: "remind" } | { kind: "wait" }
  ```
  `pausedDecision` resumes on the earliest comment by `maintainer` with `at > asked_at`. If there is none, it returns `remind` when `!reminded` and `now - asked_at >= 24h`; otherwise `wait`.
- Produces: `StatePaths.paused = join(root, "paused")`, created by `ensureStateDirs`.
- Produces (`GitHubClient`):
  - `listComments(issue: number): Promise<IssueComment[]>`, paginated with `per_page=100`;
  - `closeIssue(issue: number): Promise<void>`, a PATCH with `state: "closed", state_reason: "not_planned"`;
  - `closePullRequest(n: number): Promise<void>`, a PATCH with `state: "closed"`;
  - `deleteBranch(branch: string): Promise<void>`, a DELETE of `git/refs/heads/{branch}`; a 422 or 404 is ignored;
  - `setIssueBody(issue: number, body: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `test/paused.test.ts`.
  - **`pausedDecision`:**
    - resumes with the maintainer's comment body;
    - ignores a maintainer comment at or before `asked_at` (review focus 1);
    - ignores comments by `panelator-pipeline[bot]` and by other users;
    - returns `remind` at 24h with `reminded: false`, and `wait` at 23h59m;
    - returns `wait` at 48h with `reminded: true` (AC-15).
  - **Records:** `writePaused` then `listPaused` round-trips, and `removePaused` deletes the record.
  - **Client** (`test/client.test.ts`), using `mockGitHub`: each new method issues the expected method and path. `listComments` follows a two-page `Link` header (use `pageLink` from the helper) and maps `user.login`/`created_at`/`body`.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/paused.test.ts tools/scheduler/test/client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `scheduler: paused records, reply detection, and the issue and PR close calls (spec 006 AC-12, AC-14, AC-15)`.

---

### Task 8: Driver — new actions, rescue model, spec track, stage inputs

**Files:**
- Modify: `tools/scheduler/src/chain/driver.ts`
- Test: `tools/scheduler/test/driver.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `cfg.rescue_model`, the stage definitions;
  - Task 4: `specScopeGate`;
  - Tasks 5 and 6: actions and events;
  - Task 7: paused records and client calls;
  - `harnessForModel` from `runner/retry.ts`.
- Produces:
  - **`AGENT_STAGES`** includes `spec` and `question-check`.
  - **`ENDED`** is `["done", "released", "abandoned", "paused"]`.
  - **`branchOf(state)`** returns `` `spec-${issue}` `` on the spec track, otherwise `` `issue-${issue}` ``. `syncWorktree`, `prBound` (head ref) and the rebase use it.
  - **`buildInput`** fills:
    - `history: state.history.join("\n\n")`;
    - `question: formatQuestion(state.question)` when set;
    - `answer`, `mode: state.specMode`, `decide_input`, and `spec_problem: state.specProblem`.
  - **Rescue.** `run_stage` with `rescue: true` makes the first `exec` use `(cfg.rescue_model, harnessForModel(cfg.rescue_model))`.
  - **Spec stage `stage_ok` with `revised`.** The driver checks before emitting the event:
    - `spec_path` is under `specs/` with no `..` segment (review focus 4); otherwise it emits `stage_failed` with reason `"result: spec_path outside specs/"`;
    - `prBound` for branch `spec-N`;
    - when the issue body has no `Spec:` line, `setIssueBody` appends `\n\nSpec: <spec_path>`.
  - **Spec-track scope.** Implement and fix results on the spec track use `specScopeGate`, reading `parentBefore` from `origin/main` and `parentAfter` from the worktree.
  - **Profiles.** Review on the spec track uses profile `spec`. The `question-check` stage gets profile `null`.
  - **`applyActions`:**
    - `close_pr`: save `commitsPatch(worktree, "origin/main")` as kind `"closed-pr"`, then `closePullRequest`, `comment` on the PR, and `deleteBranch(branchOf(state))`;
    - `close_issue`: `closeIssue`;
    - `finding`: `appendFindings(paths, { issue, stage, run_id: "escalation", timestamp }, [finding])`;
    - `pause`: `writePaused({ issue, state, question, asking_stage, asked_at: now, reminded: false })` then `removeClaim`; status `"ended"`. The worktree is kept.
  - **`mergeEvent`** no longer reads labels for `security-review`.

- [ ] **Step 1: Write the failing tests** in `test/driver.test.ts`. Replace the `it.todo` entries from Task 5:
  - A plan that fails twice runs a third plan whose model is `claude-fable-5-1`. The scripted adapter's `ran` list shows `plan:claude-fable-5-1` last, and the claim's `state.rescues` is 1.
  - An `abandoned` chain makes these calls in order:
    - PATCH `/repos/o/r/pulls/9` with `state: "closed"`;
    - DELETE `/repos/o/r/git/refs/heads/issue-7`;
    - a comment;
    - labels `+abandoned`;
    - PATCH `/repos/o/r/issues/7` with `state: "closed"`;
    - one line in `findings/queue.jsonl`;
    - one notification.
  - A spec `revised` result with `spec_path: "specs/../docs/charter.md"` is recorded as a failed run, and no PATCH of the issue body is made (review focus 4).
  - A spec `revised` result for an issue whose body lacks a `Spec:` line PATCHes the body to end with `Spec: specs/010-thing/spec.md`.
  - A `send` writes `paused/7.json`, removes `claims/7.json`, and keeps the worktree directory.
  - A rescue run's prompt contains the history text. Assert on `runs/<id>/command.txt` or the prompt file the runner writes.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/driver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the driver tests, then `pnpm test`. Expected: PASS, with no `it.todo` left from Task 5.
- [ ] **Step 5: Commit** `scheduler: driver carries out rescue, re-plan, spec PRs, pause and abandonment (spec 006 AC-1 to AC-5, AC-12, AC-18)`.

---

### Task 9: Service loop — spec-start claims, resume on reply, reminders

**Files:**
- Modify: `tools/scheduler/src/service/loop.ts`
- Test: `tools/scheduler/test/loop.test.ts`

**Interfaces:**
- Consumes: `selectEligible().specProblems` (Task 4); `initialChainState(issue, specProblem)` (Task 5); paused records, `pausedDecision`, `listComments` (Task 7).
- Produces: `Scheduler.tick()` does the following, in order:
  1. Run the freshness, liveness and claim resumption steps as today.
  2. Check paused issues, inside the existing `listOpenIssues` call so it costs no extra listing. For each `listPaused` record:
     - **issue not open** (review focus 5): `removePaused`, log `paused-dropped`;
     - **`resume`**:
       - remove `needs-decision`;
       - `ensureWorktree`;
       - write a claim with `state: transition(record.state, { type: "answered", answer }).state`;
       - add `in-progress`;
       - `removePaused`;
       - start the chain, using a free slot before any shortlisted issue (AC-14);
     - **`remind`**: `notify({ issue, gate: "question-reminder", label: "needs-decision", text: "Still waiting on your answer: " + question.question })`, then rewrite the record with `reminded: true`;
     - **`wait`**: nothing.

     When `pausedDecision` returns `resume` but no slot is free, the record stays and is retried next tick.
  3. Shortlist claims use `initialChainState(issue.number, specProblems.get(issue.number) ?? null)`.
  4. Label decisions from the shortlist, now only `needs-design-stage`, are applied as today, once, because the `needs-` prefix skip then hides the issue.

  Reordering detail: today the loop lists open issues after resuming claims and only when a slot is free. Move the listing so it happens whenever paused records exist or a slot is free.

- [ ] **Step 1: Write the failing tests** in `test/loop.test.ts`:
  - **Replace the `it.todo` "labels needs-spec"** with: an issue whose spec is missing is claimed, and its claim's `state.specProblem` matches `/not found on main/`. No label other than `in-progress` is added (AC-16).
  - **Resume:** a `paused/7.json` record plus a maintainer comment after `asked_at`, with one slot and a priority-labelled issue 8 eligible. After `tick()`, `info.claimed` is `[7]`, issue 8 is not claimed, and `needs-decision` is removed. The claim for 7 has `state.stage` equal to the record's `asking_stage` and `state.answer` equal to the comment body.
  - **Reminder:** a 25-hour-old record with no comment sends one `question-reminder` notification. A second `tick()` sends none (AC-15).
  - **Closed issue:** a paused record whose issue is absent from the open-issue list is removed, and no claim is made (review focus 5).
  - **UI issue:** an issue with a `web-ui` spec and no design gets `needs-design-stage` once. A second tick, with the label now present, adds nothing and sends no notification (AC-17).
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/loop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the loop tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `scheduler: resume paused issues on the maintainer's reply ahead of the shortlist; one reminder (spec 006 AC-14, AC-15, AC-16, AC-17)`.

---

### Task 10: Recorded end-to-end chains

**Files:**
- Modify: `tools/scheduler/test/e2e.test.ts`
- Possibly create: `tools/scheduler/test/helpers/e2e-routes.ts` (shared mock routes, if `e2e.test.ts` becomes repetitive)

**Interfaces:**
- Consumes: everything above; the e2e harness already in `e2e.test.ts` (`scripted`, `repoPair`, `mockGitHub`, `Scheduler`).

Seven chains (AC-24). Each drives `Scheduler.tick()` until the chain ends, then asserts the ordered `labelLog`, the `comments`, and the stage list in the adapter's `ran`:

| Chain | Scripted results | Asserts |
|---|---|---|
| rescue then merge | plan fails twice, then rescue plan ok, implement ok, review approve | `ran` ends `…plan, plan, plan, implement, review`; merged; `labelLog` = `+in-progress, -in-progress` |
| re-plan then merge | implement fails twice, rescue implement fails, plan ok, implement ok, approve | a PR close PATCH; a `closed-pr` patch file; merged |
| spec revision then merge | as above, then the second implement also fails | spec stage `mode: revise`; spec PR 12 verified, reviewed with the `spec` profile, merged; then plan → … → merged |
| question paused, answered, merged | review escalate technical; check `send`; maintainer comment; review approve | comment headed `### Question for the maintainer`; `+needs-decision`, `-needs-decision`; resumed review input contains the answer; merged |
| decide_yourself then merge | review escalate technical; check `decide_yourself`; review approve | no `needs-decision`; review input contains the reasoning |
| abandonment | every stage fails after spec revision | `+abandoned`; issue closed; one finding queued |
| security finding fixed then merged | diff touches `agents/x.md`; security review with one finding; fix; security review approve | no `security-review` or `needs-human` label; two review runs with the security profile; merged |

- [ ] **Step 1: Write the seven tests**, one `it` each, named after the table rows with `(spec 006 AC-24)`.
- [ ] **Step 2: Run** `pnpm vitest run tools/scheduler/test/e2e.test.ts`. Expected: the new tests PASS. They are acceptance tests over finished code; a failure here is a bug in Tasks 4 to 9, so fix it in the owning module with a unit test first.
- [ ] **Step 3: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 4: Commit** `scheduler: recorded end-to-end chains for every escalation outcome (spec 006 AC-24)`.

---

### Task 11: Documents

**Files:**
- Modify: `docs/process-spec.md`, `specs/001-scheduler-core/spec.md`, `specs/README.md`, `docs/delivery-system-design.md`

These edits are content, with no tests beyond the tree check of Task 3. Each states the new rule and cites spec 006, without restating its mechanics.

- [ ] **Step 1: `docs/process-spec.md`.**
  - **Top:** a line linking `charter.md` as the document above this one.
  - **Section 2:** replace "the maintainer is in the loop at **one** gate, requirements grilling" with a pointer to design section 3.
  - **Section 3, Spec row:** "agent drafts; checked by an agent against the grilling record (spec 006)".
  - **Section 5:**
    - sensitive-path findings go to the fix loop (spec 006);
    - automation changes go through normal review, and only `charter.md` is locked;
    - stable promotion follows design section 5 (the test board), with "the one human release action" removed.
- [ ] **Step 2: `specs/001-scheduler-core/spec.md`.**
  - **Status line:** append "; amended by spec 006".
  - **Section 2:** "(spec 002)" for the shortlist becomes "(a later spec)", and the Telegram "(spec 003)" and filing agent "(spec 004)" become design specs A and C.
  - **Superseded items:** prefix AC-7 to AC-13, the section 5 `needs-human` rows and the section 8 rows that AC-1 to AC-19 of spec 006 replace with `Superseded by spec 006:`, leaving their text in place.
- [ ] **Step 3: `specs/README.md`.**
  - No maintainer approval for specs derived from an approved design.
  - Every spec carries `Parent:`, and its parent lists it under `## Children`.
  - The hierarchy rules of design section 10, in four sentences.
- [ ] **Step 4: `docs/delivery-system-design.md` section 11 table.** Move "the section 3 classification check" from row A to row B.
- [ ] **Step 5: Verify.** Run `pnpm test`; expected PASS, including the tree check. Run `git diff --stat main -- docs/charter.md`; expected empty.
- [ ] **Step 6: Commit** `docs: process spec, spec 001 and the specs README follow spec 006`.

---

## Final check

- [ ] `pnpm test` from the repo root: all files pass. Paste the summary into the final message.
- [ ] `grep -rn "needs-human\|NEEDS_HUMAN\|securityFinding\|merge_blocked\|automationChangeGate" tools/scheduler/src` prints nothing.
- [ ] `git diff --stat main -- docs/charter.md` prints nothing.
