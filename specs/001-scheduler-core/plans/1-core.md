# Spec 001, Plan 1 of 3: Core (schemas, spec parsing, stage definitions, gates, chain, notify)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pure, network-free half of `tools/scheduler`: schema validation, spec and stage-definition parsing, every gate of spec section 8 as a tested function, the chain state machine of section 5, the ranking of section 7, the notification interface with rate limiting, and the committed `agents/` content the rest depends on.

**Architecture:** One pnpm workspace package `tools/scheduler` (`@panelator/scheduler`), TypeScript ESM run natively by Node 26 (type stripping, no build step), tests in vitest from the repo root. Every module in this plan is a pure function over plain data or touches only a temp directory. Plan 2 adds adapters, the runner and the state directory; plan 3 adds GitHub, script stages, the poll loop and the systemd service.

**Tech Stack:** Node 26 (native `.ts` execution, `erasableSyntaxOnly`), TypeScript 7 (typecheck only), vitest 3, ajv 8 + ajv-formats 3, yaml 2.

**Spec:** `specs/001-scheduler-core/spec.md`. Read it first; task text cites its sections and acceptance criteria (AC-n). Plans 2 and 3 are `plans/2-runs.md` and `plans/3-service.md`.

## Global Constraints

- Package manager is pnpm; `pnpm test` from the repo root must pass before any task is called done, and its output goes in the final message (AGENTS.md).
- Commit on the branch you were told to use; do not push (AGENTS.md).
- TypeScript only, ESM, `erasableSyntaxOnly`: no `enum`, no parameter properties, no namespaces. Relative imports carry the `.ts` extension so Node runs the source directly.
- No test touches the network (spec section 17). Nothing in this plan spawns a process either.
- "Every rule the process spec says must be enforced in the script, not in a prompt, is a tested function in this package" (spec section 1). Gates and the chain are data in, data out.
- Stage order and the fix bound live in the chain module, never in a stage definition (spec section 5).
- Label vocabulary (decided during planning): `validated`, `in-progress`, `needs-spec`, `needs-design`, `needs-clarification`, `needs-human`, `security-review`, `blocked`, `priority`, and change class `class:product`, `class:bug`, `class:tooling`, `class:dependency`. `class:product` is "feature"; the other three are "debt" for the 2:1 ratio.
- An issue links its spec with one line in its body: `Spec: specs/NNN-slug/spec.md`.
- Model ids as of planning: Claude strong tier `claude-fable-5-1`, Claude standard `claude-sonnet-5-5`, Claude fallback `claude-opus-5-5`; pi standard `openai/gpt-6.1-sol` (the only OpenAI models usable on the ChatGPT subscription through pi are the `gpt-5.3-codex*` and `gpt-6*` families; `gpt-5.x` non-codex models return HTTP 400).

## Review Focus

Inputs the spec implies but no task's tests exercised until these lines were added. Each has its pinning test in the owning task.

1. **A spec file with headings numbered differently, or unnumbered** (`## Goal` vs `## 2. Goal`): the Spec present gate must match on the heading words, not the number. Pinned in Task 4.
2. **An issue body whose `Spec:` line points outside `specs/`** (`Spec: ../../etc/passwd`): must be rejected as "no spec link", never resolved on disk. Pinned in Task 4.
3. **A label event list where `validated` was added by the maintainer, removed, then re-added by the bot**: the Authority and Automation gates must key on the *latest* `validated` add, not the first. Pinned in Task 6.
4. **A diff file list containing a path that is both inside the plan scope and sensitive but not listed in the spec**: Scope must fail on the sensitive rule even though the file is in scope. Pinned in Task 6.
5. **A review result that carries `findings_on_pr` entries with `criterion: "style"`**: schema validation must reject it (spec section 6: style nits are rejected by schema). Pinned in Task 2.

## File structure

```
tools/scheduler/
  package.json                 @panelator/scheduler, scripts: test, typecheck
  tsconfig.json
  src/
    types.ts                   shared plain-data types (IssueData, LabelEvent, StageDefinition, Bounds, ...)
    config.ts                  load + validate agents/scheduler.yaml -> Config
    schema/validate.ts         ajv wrapper: validate(name, data) -> {ok, errors}
    spec/link.ts               specPathFromIssueBody(body) -> path | null
    spec/parse.ts              parseSpec(text) -> ParsedSpec (sections, domain, open decisions, listed paths)
    stages/definition.ts       parseStageDefinition(markdown) -> StageDefinition; loadStageDefinitions(dir)
    stages/prompt.ts           renderPrompt(template, input) -> string
    profiles/resolve.ts        resolveProfile(agentsDir, name) -> Profile
    gates/types.ts             GateResult
    gates/authority.ts         authorityGate
    gates/validated.ts         validatedGate
    gates/spec-present.ts      specPresentGate
    gates/ui-design.ts         uiDesignGate
    gates/automation-change.ts automationChangeGate
    gates/ready.ts             readyGate
    gates/scope.ts             scopeGate
    gates/sensitive.ts         sensitivePathGate (isSensitive, globs)
    gates/fix-loop.ts          fixLoopGate
    gates/liveness.ts          livenessGate
    gates/index.ts             re-exports
    shortlist/rank.ts          rankIssues(issues) -> ordered
    shortlist/select.ts        selectEligible(issues, ctx) -> {eligible, decisions}
    chain/machine.ts           initialChainState, transition(state, event) -> {state, actions}
    chain/types.ts             ChainState, ChainEvent, Action
    notify/types.ts            Notifier interface
    notify/log.ts              LogNotifier (appends to a log file)
    notify/rate-limit.ts       rateLimited(notifier, hours, clock)
    glob.ts                    tiny glob matcher (**, *, trailing /)
  test/
    *.test.ts                  one file per module above
    fixtures/specs/            spec fixtures for the parser and gates
agents/
  scheduler.yaml
  sensitive-paths.txt
  stages/plan.md, implement.md, review.md, fix.md
  profiles/backend/profile.yaml, instructions.md, skills/.gitkeep
  profiles/security/profile.yaml, instructions.md, review-criteria.md
schemas/scheduler/
  plan-result.json, implement-result.json, review-result.json, fix-result.json,
  usage-record.json, finding.json, claim.json, stage-input.json
```

---

### Task 1: Package scaffold

**Files:**
- Create: `tools/scheduler/package.json`
- Create: `tools/scheduler/tsconfig.json`
- Create: `tools/scheduler/src/types.ts`
- Create: `tools/scheduler/test/smoke.test.ts`
- Modify: `tools/README.md`

**Interfaces:**
- Produces: the types in `src/types.ts` below. Every later task imports from it.

- [ ] **Step 1: Write the failing smoke test**

`tools/scheduler/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBounds } from "../src/types.ts";

describe("scheduler package", () => {
  it("loads and exposes the shared type guards", () => {
    expect(isBounds({ timeout_min: 1, max_turns: 1, max_cost_usd: 1 })).toBe(true);
    expect(isBounds({ timeout_min: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tools/scheduler/test/smoke.test.ts`
Expected: FAIL, cannot find module `../src/types.ts`.

- [ ] **Step 3: Create the package, tsconfig and types**

`tools/scheduler/package.json`:

```json
{
  "name": "@panelator/scheduler",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Deterministic scheduler for the panelator implementation chain (spec 001).",
  "bin": { "panelator-scheduler": "./bin/scheduler.ts" },
  "scripts": {
    "test": "cd ../.. && vitest run tools/scheduler",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "engines": { "node": ">=26" },
  "dependencies": {
    "ajv": "^8.20.0",
    "ajv-formats": "^3.0.1",
    "octokit": "^5.0.5",
    "yaml": "^2.9.1"
  },
  "devDependencies": {
    "@types/node": "^26.6.5",
    "typescript": "^7.0.2"
  }
}
```

`tools/scheduler/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2024"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "test/**/*.ts"]
}
```

`tools/scheduler/src/types.ts`:

```ts
export type Harness = "claude" | "pi" | "fake";
export type Tier = "strong" | "standard";
export type AgentStageName = "plan" | "implement" | "review" | "fix";
export type StageName = AgentStageName | "verify" | "merge";

export interface Bounds {
  timeout_min: number;
  max_turns: number;
  max_cost_usd: number;
}

export function isBounds(x: unknown): x is Bounds {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.timeout_min === "number" &&
    typeof b.max_turns === "number" &&
    typeof b.max_cost_usd === "number"
  );
}

export interface StageDefinition {
  name: AgentStageName;
  kind: "agent";
  harness: Exclude<Harness, "fake">;
  model: string;
  fallback?: string;
  tier: Tier;
  effort?: string;
  bounds: Bounds;
  permission: "no-prompt";
  worktree: "issue" | "fresh";
  profile: "from-issue" | "none" | string;
  input: string;
  output: string;
  prompt: string;
}

/** A labelling event from the issue timeline, oldest first. */
export interface LabelEvent {
  label: string;
  actor: string;
  action: "labeled" | "unlabeled";
  at: string;
}

export interface IssueData {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  labelEvents: LabelEvent[];
  createdAt: string;
}

export interface PlanTask {
  id: string;
  description: string;
  files: string[];
}

export interface PlanResult {
  verdict: "ready" | "spec_gap";
  domain: string;
  tasks: PlanTask[];
  questions?: string[];
  findings?: Finding[];
}

export interface ImplementResult {
  pr_number: number;
  head_sha: string;
  tasks_done: string[];
  findings?: Finding[];
}

export interface ReviewFinding {
  criterion: string;
  file: string;
  line: number;
  scenario: string;
}

export interface ReviewResult {
  verdict: "approve" | "changes_requested" | "escalate";
  findings_on_pr: ReviewFinding[];
  declined_to_judge: string[];
  findings?: Finding[];
}

export interface FixResult {
  head_sha: string;
  addressed: number[];
  findings?: Finding[];
}

export interface Finding {
  what: string;
  where: string;
  evidence: string;
  suspected_cause?: string;
  noticed_how: string;
  security?: boolean;
}

export interface Profile {
  name: string;
  dir: string;
  skillsDir: string;
  instructions: string;
  tools: string[];
  credentialHook?: string;
  reviewCriteria?: string;
}
```

Install dependencies: `pnpm install` from the repo root (the workspace already includes `tools/*`).

Append to `tools/README.md`:

```markdown

- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm vitest run tools/scheduler/test/smoke.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 1 passed; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler tools/README.md pnpm-lock.yaml
git commit -m "scheduler: package scaffold and shared types (spec 001)"
```

---

### Task 2: Schemas and the validator

**Files:**
- Create: `schemas/scheduler/plan-result.json`, `implement-result.json`, `review-result.json`, `fix-result.json`, `finding.json`, `usage-record.json`, `claim.json`, `stage-input.json`
- Create: `tools/scheduler/src/schema/validate.ts`
- Test: `tools/scheduler/test/schema.test.ts`

**Interfaces:**
- Produces: `validate(name: SchemaName, data: unknown): { ok: true } | { ok: false; errors: string[] }` and `type SchemaName = "plan-result" | "implement-result" | "review-result" | "fix-result" | "finding" | "usage-record" | "claim" | "stage-input"`. `schemaDir` resolves to `<repo>/schemas/scheduler` relative to the source file.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validate } from "../src/schema/validate.ts";

const finding = {
  what: "duplicate pagination code",
  where: "tools/scheduler/src/github/client.ts:40",
  evidence: "two functions with the same loop",
  noticed_how: "while adding the checks call",
};

describe("result schemas", () => {
  it("accepts a ready plan result", () => {
    const r = validate("plan-result", {
      verdict: "ready",
      domain: "backend",
      tasks: [{ id: "T1", description: "add module", files: ["tools/scheduler/src/a.ts"] }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a plan result whose task has no files", () => {
    const r = validate("plan-result", {
      verdict: "ready",
      domain: "backend",
      tasks: [{ id: "T1", description: "add module" }],
    });
    expect(r.ok).toBe(false);
  });

  it("requires questions on a spec_gap verdict", () => {
    expect(validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [] }).ok).toBe(false);
    expect(
      validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["which port?"] }).ok,
    ).toBe(true);
  });

  it("accepts an implement result", () => {
    expect(
      validate("implement-result", { pr_number: 12, head_sha: "a".repeat(40), tasks_done: ["T1"], findings: [finding] }).ok,
    ).toBe(true);
  });

  it("rejects a review finding without an AC or rule criterion (style nit)", () => {
    const base = { verdict: "changes_requested", declined_to_judge: [] };
    const good = { ...base, findings_on_pr: [{ criterion: "AC-10", file: "x.ts", line: 3, scenario: "diff touches y" }] };
    const rule = { ...base, findings_on_pr: [{ criterion: "rule:AGENTS.md pnpm test", file: "x.ts", line: 3, scenario: "tests not run" }] };
    const nit = { ...base, findings_on_pr: [{ criterion: "style", file: "x.ts", line: 3, scenario: "prefer const" }] };
    expect(validate("review-result", good).ok).toBe(true);
    expect(validate("review-result", rule).ok).toBe(true);
    const r = validate("review-result", nit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/criterion/);
  });

  it("rejects a fix result with a short sha", () => {
    expect(validate("fix-result", { head_sha: "abc", addressed: [0] }).ok).toBe(false);
  });

  it("validates a usage record with null cost", () => {
    const ok = validate("usage-record", {
      run_id: "r1", issue: 1, stage: "plan", attempt: 1, outcome: "ok", harness: "pi", model: "openai/gpt-6.1-sol",
      cost_usd: null, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      turns: 1, tool_calls: 0, wall_seconds: 2.5, started_at: "2026-10-12T00:00:00Z", ended_at: "2026-10-12T00:00:02Z",
      events_path: "runs/r1/events.jsonl",
    });
    expect(ok.ok).toBe(true);
  });

  it("validates a claim record", () => {
    expect(
      validate("claim", {
        issue: 7, slot: 0, state: { stage: "plan" }, worktree: "/tmp/wt", started_at: "2026-10-12T00:00:00Z",
        last_activity_at: "2026-10-12T00:00:00Z", run_id: null,
      }).ok,
    ).toBe(true);
  });

  it("reports unknown schema names", () => {
    // @ts-expect-error unknown name on purpose
    expect(() => validate("nope", {})).toThrow(/unknown schema/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/schema.test.ts`
Expected: FAIL, cannot find `../src/schema/validate.ts`.

- [ ] **Step 3: Write the schemas**

`schemas/scheduler/finding.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "finding.json",
  "title": "Finding record (process-spec 4.2)",
  "type": "object",
  "required": ["what", "where", "evidence", "noticed_how"],
  "additionalProperties": false,
  "properties": {
    "what": { "type": "string", "minLength": 1 },
    "where": { "type": "string", "minLength": 1 },
    "evidence": { "type": "string", "minLength": 1 },
    "suspected_cause": { "type": "string" },
    "noticed_how": { "type": "string", "minLength": 1 },
    "security": { "type": "boolean" }
  }
}
```

`schemas/scheduler/plan-result.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "plan-result.json",
  "type": "object",
  "required": ["verdict", "domain", "tasks"],
  "additionalProperties": false,
  "properties": {
    "verdict": { "enum": ["ready", "spec_gap"] },
    "domain": { "enum": ["backend", "web-ui", "widget", "firmware", "infra"] },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "description", "files"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "description": { "type": "string", "minLength": 1 },
          "files": { "type": "array", "items": { "type": "string", "minLength": 1 } }
        }
      }
    },
    "questions": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "findings": { "type": "array", "items": { "$ref": "finding.json" } }
  },
  "if": { "properties": { "verdict": { "const": "spec_gap" } } },
  "then": { "required": ["questions"], "properties": { "questions": { "minItems": 1 } } }
}
```

`schemas/scheduler/implement-result.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "implement-result.json",
  "type": "object",
  "required": ["pr_number", "head_sha", "tasks_done"],
  "additionalProperties": false,
  "properties": {
    "pr_number": { "type": "integer", "minimum": 1 },
    "head_sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "tasks_done": { "type": "array", "items": { "type": "string" } },
    "findings": { "type": "array", "items": { "$ref": "finding.json" } }
  }
}
```

`schemas/scheduler/review-result.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "review-result.json",
  "type": "object",
  "required": ["verdict", "findings_on_pr", "declined_to_judge"],
  "additionalProperties": false,
  "properties": {
    "verdict": { "enum": ["approve", "changes_requested", "escalate"] },
    "findings_on_pr": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["criterion", "file", "line", "scenario"],
        "additionalProperties": false,
        "properties": {
          "criterion": { "type": "string", "pattern": "^(AC-[0-9]+|rule:.+)$" },
          "file": { "type": "string", "minLength": 1 },
          "line": { "type": "integer", "minimum": 0 },
          "scenario": { "type": "string", "minLength": 1 }
        }
      }
    },
    "declined_to_judge": { "type": "array", "items": { "type": "string" } },
    "findings": { "type": "array", "items": { "$ref": "finding.json" } }
  }
}
```

`schemas/scheduler/fix-result.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "fix-result.json",
  "type": "object",
  "required": ["head_sha", "addressed"],
  "additionalProperties": false,
  "properties": {
    "head_sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "addressed": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
    "findings": { "type": "array", "items": { "$ref": "finding.json" } }
  }
}
```

`schemas/scheduler/usage-record.json` (AC-24 field list, verbatim):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "usage-record.json",
  "type": "object",
  "required": [
    "run_id", "issue", "stage", "attempt", "outcome", "harness", "model", "cost_usd",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "turns", "tool_calls", "wall_seconds", "started_at", "ended_at", "events_path"
  ],
  "additionalProperties": false,
  "properties": {
    "run_id": { "type": "string", "minLength": 1 },
    "issue": { "type": "integer", "minimum": 1 },
    "stage": { "enum": ["plan", "implement", "review", "fix"] },
    "attempt": { "type": "integer", "minimum": 1 },
    "outcome": { "enum": ["ok", "failed", "timeout", "bounds"] },
    "harness": { "enum": ["claude", "pi", "fake"] },
    "model": { "type": "string" },
    "cost_usd": { "type": ["number", "null"] },
    "input_tokens": { "type": "integer" },
    "output_tokens": { "type": "integer" },
    "cache_read_tokens": { "type": "integer" },
    "cache_write_tokens": { "type": "integer" },
    "turns": { "type": "integer" },
    "tool_calls": { "type": "integer" },
    "wall_seconds": { "type": "number" },
    "started_at": { "type": "string", "format": "date-time" },
    "ended_at": { "type": "string", "format": "date-time" },
    "events_path": { "type": "string" }
  }
}
```

`schemas/scheduler/claim.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "claim.json",
  "type": "object",
  "required": ["issue", "slot", "state", "worktree", "started_at", "last_activity_at", "run_id"],
  "additionalProperties": false,
  "properties": {
    "issue": { "type": "integer", "minimum": 1 },
    "slot": { "type": "integer", "minimum": 0 },
    "state": { "type": "object" },
    "worktree": { "type": "string" },
    "started_at": { "type": "string", "format": "date-time" },
    "last_activity_at": { "type": "string", "format": "date-time" },
    "run_id": { "type": ["string", "null"] }
  }
}
```

`schemas/scheduler/stage-input.json` (what `renderPrompt` receives; plan 2 writes it beside the prompt):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "stage-input.json",
  "type": "object",
  "required": ["issue", "spec", "result_path", "profile_instructions"],
  "additionalProperties": false,
  "properties": {
    "issue": {
      "type": "object",
      "required": ["number", "title", "body"],
      "properties": {
        "number": { "type": "integer" },
        "title": { "type": "string" },
        "body": { "type": "string" }
      }
    },
    "spec": { "type": "string" },
    "plan": { "type": "object" },
    "pr": {
      "type": "object",
      "required": ["number", "head_sha", "url"],
      "properties": {
        "number": { "type": "integer" },
        "head_sha": { "type": "string" },
        "url": { "type": "string" }
      }
    },
    "ci": { "type": "string" },
    "findings": { "type": "string" },
    "fix_input": { "type": "string" },
    "result_path": { "type": "string" },
    "profile_instructions": { "type": "string" }
  }
}
```

- [ ] **Step 4: Write the validator**

`tools/scheduler/src/schema/validate.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export type SchemaName =
  | "plan-result"
  | "implement-result"
  | "review-result"
  | "fix-result"
  | "finding"
  | "usage-record"
  | "claim"
  | "stage-input";

const NAMES: SchemaName[] = [
  "finding",
  "plan-result",
  "implement-result",
  "review-result",
  "fix-result",
  "usage-record",
  "claim",
  "stage-input",
];

export const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "schemas", "scheduler");

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const name of NAMES) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8")), `${name}.json`);
}

export type Validation = { ok: true } | { ok: false; errors: string[] };

export function validate(name: SchemaName, data: unknown): Validation {
  const fn = ajv.getSchema(`${name}.json`);
  if (!fn) throw new Error(`unknown schema: ${name}`);
  if (fn(data)) return { ok: true };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { ok: false, errors };
}
```

Both default imports were verified under Node 26 ESM on 2026-10-12: `ajv/dist/2020.js` and `ajv-formats` are CommonJS, and Node hands their `module.exports` function to the default import. `$ref: "finding.json"` resolves because every schema is registered under its file name as key.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/schema.test.ts`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add schemas/scheduler tools/scheduler/src/schema tools/scheduler/test/schema.test.ts
git commit -m "scheduler: result, usage, finding and claim schemas with ajv validator (AC-22, AC-24, AC-28)"
```

---

### Task 3: Glob matcher and config loader

**Files:**
- Create: `tools/scheduler/src/glob.ts`
- Create: `tools/scheduler/src/config.ts`
- Create: `agents/scheduler.yaml`
- Test: `tools/scheduler/test/glob.test.ts`, `tools/scheduler/test/config.test.ts`

**Interfaces:**
- Produces: `globToRegExp(glob: string): RegExp`, `matchesAny(path: string, globs: string[]): boolean`.
- Produces: `loadConfig(path: string): Config` and the `Config` type below; `defaultConfigPath = <repo>/agents/scheduler.yaml`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/glob.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/glob.ts";

describe("matchesAny", () => {
  it("matches a directory prefix written with a trailing slash", () => {
    expect(matchesAny("tools/scheduler/src/a.ts", ["tools/scheduler/"])).toBe(true);
    expect(matchesAny("tools/schedulerx/a.ts", ["tools/scheduler/"])).toBe(false);
  });
  it("matches ** across directories and * within one", () => {
    expect(matchesAny("backend/auth/x.rs", ["backend/**/auth/**"])).toBe(true);
    expect(matchesAny("backend/auth.rs", ["backend/*.rs"])).toBe(true);
    expect(matchesAny("backend/a/auth.rs", ["backend/*.rs"])).toBe(false);
  });
  it("matches an exact file", () => {
    expect(matchesAny(".github/workflows/ci.yml", [".github/"])).toBe(true);
    expect(matchesAny("pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
  });
});
```

`tools/scheduler/test/config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("loads the committed agents/scheduler.yaml with defaults", () => {
    const c = loadConfig(defaultConfigPath);
    expect(c.repo).toBe("adam26davidson/panelator");
    expect(c.slots).toBe(1);
    expect(c.poll_interval_s).toBe(45);
    expect(c.liveness_hours).toBe(2);
    expect(c.state_dir.startsWith("/")).toBe(true);
  });
  it("rejects slots below 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, "repo: a/b\nmaintainer: a\napp: {id: 1, installation_id: 1, private_key_path: /k, bot_login: x[bot]}\nslots: 0\n");
    expect(() => loadConfig(p)).toThrow(/slots/);
  });
  it("expands ~ in paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, "repo: a/b\nmaintainer: a\napp: {id: 1, installation_id: 1, private_key_path: ~/k.pem, bot_login: x[bot]}\nstate_dir: ~/st\n");
    const c = loadConfig(p);
    expect(c.state_dir).not.toContain("~");
    expect(c.app.private_key_path).not.toContain("~");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/glob.test.ts tools/scheduler/test/config.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement glob, config and the committed config file**

`tools/scheduler/src/glob.ts`:

```ts
/** Minimal gitignore-style matcher: `dir/` is a prefix, `*` is within a segment, `**` spans segments. */
export function globToRegExp(glob: string): RegExp {
  if (glob.endsWith("/")) return new RegExp("^" + escape(glob) + ".*$");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
```

`agents/scheduler.yaml`:

```yaml
# Read once at service start (spec section 14). Everything else is fetched from main at runtime.
repo: adam26davidson/panelator
maintainer: adam26davidson
app:
  id: 0                      # set after the GitHub App is created (plan 3, Task 1)
  installation_id: 0
  private_key_path: ~/.config/panelator/scheduler-app.pem
  bot_login: panelator-pipeline[bot]
poll_interval_s: 45
slots: 1
liveness_hours: 2
retry_cost_limit_usd: 1.0
notify_rate_limit_hours: 4
state_dir: ~/.local/state/panelator-scheduler
labels:
  validated: validated
  claim: in-progress
  priority: priority
  feature_classes: [class:product]
  debt_classes: [class:bug, class:tooling, class:dependency]
systemd:
  scope: true                # wrap stages in systemd-run --user --scope
  inhibit: true              # hold systemd-inhibit while a stage is in flight
decide:
  base_url: ""               # /v1/systemone; unused in v0
  key_env: PANELATOR_DECIDE_KEY
```

`tools/scheduler/src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface Config {
  repo: string;
  maintainer: string;
  app: { id: number; installation_id: number; private_key_path: string; bot_login: string };
  poll_interval_s: number;
  slots: number;
  liveness_hours: number;
  retry_cost_limit_usd: number;
  notify_rate_limit_hours: number;
  state_dir: string;
  labels: {
    validated: string;
    claim: string;
    priority: string;
    feature_classes: string[];
    debt_classes: string[];
  };
  systemd: { scope: boolean; inhibit: boolean };
  decide: { base_url: string; key_env: string };
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const defaultConfigPath = join(repoRoot, "agents", "scheduler.yaml");
export const agentsDir = join(repoRoot, "agents");

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const num = (k: string, d: number) => {
    const v = raw[k] ?? d;
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`config ${k} must be a number`);
    return v;
  };
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v !== "string" || !v) throw new Error(`config ${k} is required`);
    return v;
  };
  const app = (raw.app ?? {}) as Record<string, unknown>;
  const labels = (raw.labels ?? {}) as Record<string, unknown>;
  const systemd = (raw.systemd ?? {}) as Record<string, unknown>;
  const decide = (raw.decide ?? {}) as Record<string, unknown>;
  const cfg: Config = {
    repo: str("repo"),
    maintainer: str("maintainer"),
    app: {
      id: Number(app.id ?? 0),
      installation_id: Number(app.installation_id ?? 0),
      private_key_path: expandHome(String(app.private_key_path ?? "~/.config/panelator/scheduler-app.pem")),
      bot_login: String(app.bot_login ?? ""),
    },
    poll_interval_s: num("poll_interval_s", 45),
    slots: num("slots", 1),
    liveness_hours: num("liveness_hours", 2),
    retry_cost_limit_usd: num("retry_cost_limit_usd", 1),
    notify_rate_limit_hours: num("notify_rate_limit_hours", 4),
    state_dir: expandHome(String(raw.state_dir ?? "~/.local/state/panelator-scheduler")),
    labels: {
      validated: String(labels.validated ?? "validated"),
      claim: String(labels.claim ?? "in-progress"),
      priority: String(labels.priority ?? "priority"),
      feature_classes: (labels.feature_classes as string[]) ?? ["class:product"],
      debt_classes: (labels.debt_classes as string[]) ?? ["class:bug", "class:tooling", "class:dependency"],
    },
    systemd: { scope: systemd.scope !== false, inhibit: systemd.inhibit !== false },
    decide: { base_url: String(decide.base_url ?? ""), key_env: String(decide.key_env ?? "PANELATOR_DECIDE_KEY") },
  };
  if (cfg.slots < 1) throw new Error("config slots must be >= 1");
  if (cfg.poll_interval_s < 5) throw new Error("config poll_interval_s must be >= 5");
  if (!cfg.app.bot_login) throw new Error("config app.bot_login is required");
  return cfg;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/glob.test.ts tools/scheduler/test/config.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add agents/scheduler.yaml tools/scheduler/src/glob.ts tools/scheduler/src/config.ts tools/scheduler/test/glob.test.ts tools/scheduler/test/config.test.ts
git commit -m "scheduler: config loader, committed scheduler.yaml and glob matcher"
```

---

### Task 4: Spec link and spec parser

**Files:**
- Create: `tools/scheduler/src/spec/link.ts`
- Create: `tools/scheduler/src/spec/parse.ts`
- Create: `tools/scheduler/test/fixtures/specs/good-backend.md`, `good-webui.md`, `missing-verification.md`, `open-decisions.md`, `unnumbered.md`
- Test: `tools/scheduler/test/spec.test.ts`

**Interfaces:**
- Produces: `specPathFromIssueBody(body: string): string | null`.
- Produces: `parseSpec(text: string): ParsedSpec` with
  ```ts
  interface ParsedSpec {
    status: string | null;            // text after "Status:"
    class: string | null;             // "tooling" from "Class: tooling."
    domain: string | null;            // "automation" from "Domain: automation"
    derivesFrom: boolean;             // a "Derives from:" line exists
    sections: Record<RequiredSection, boolean>;
    openDecisionsEmpty: boolean;
    uiScreens: string[];              // names from the UI design section's "Screens:" list
    listedPaths: string[];            // backticked paths in Interfaces and files
    missing: string[];                // human-readable list of missing required parts
  }
  type RequiredSection = "goal" | "out-of-scope" | "acceptance-criteria" | "interfaces" | "verification" | "ui-design" | "open-decisions";
  ```
  `missing` is empty when the spec satisfies section 10 for its domain.

- [ ] **Step 1: Write fixtures**

`tools/scheduler/test/fixtures/specs/good-backend.md`:

```markdown
# 010. Example backend feature

Status: approved by the maintainer 2026-10-12
Class: product. Domain: backend.
Derives from: [design-tree](../../docs/design-tree.md) R3.

## 1. Goal

Do a thing.

## 2. Out of scope

Other things.

## 3. Acceptance criteria

- AC-1. Given x, when y, then z.

## 4. Interfaces and files

- `backend/crates/thing/src/lib.rs`
- `schemas/thing.json`

## 5. Verification

`cargo test -p thing`.

## 6. Open decisions

None.
```

`tools/scheduler/test/fixtures/specs/good-webui.md`:

```markdown
# 011. Example screen

Status: approved by the maintainer 2026-10-12
Class: product. Domain: web-ui.
Derives from: [design-tree](../../docs/design-tree.md) R4.

## 1. Goal

A screen.

## 2. Out of scope

Nothing.

## 3. Acceptance criteria

- AC-1. Given a, when b, then c.

## 4. Interfaces and files

- `web/src/pages/editor/`

## 5. Verification

Storybook story renders; screenshot matches.

## 6. UI design

Screens: editor-empty, editor-populated

Flow: open -> edit -> save.

## 7. Open decisions

None.
```

`tools/scheduler/test/fixtures/specs/missing-verification.md`: copy `good-backend.md` and delete the `## 5. Verification` heading and its paragraph.

`tools/scheduler/test/fixtures/specs/open-decisions.md`: copy `good-backend.md` and replace the Open decisions body `None.` with `- Which port?`.

`tools/scheduler/test/fixtures/specs/unnumbered.md`: copy `good-backend.md` and remove every `N. ` number prefix from the headings (`## Goal`, `## Out of scope`, ...).

- [ ] **Step 2: Write the failing tests**

`tools/scheduler/test/spec.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specPathFromIssueBody } from "../src/spec/link.ts";
import { parseSpec } from "../src/spec/parse.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "specs", n), "utf8");

describe("specPathFromIssueBody", () => {
  it("finds the Spec: line", () => {
    expect(specPathFromIssueBody("Intro\n\nSpec: specs/010-thing/spec.md\n")).toBe("specs/010-thing/spec.md");
  });
  it("returns null without one", () => {
    expect(specPathFromIssueBody("no link here")).toBeNull();
  });
  it("rejects paths outside specs/ (review focus 2)", () => {
    expect(specPathFromIssueBody("Spec: ../../etc/passwd")).toBeNull();
    expect(specPathFromIssueBody("Spec: specs/../docs/x.md")).toBeNull();
    expect(specPathFromIssueBody("Spec: specs/010-thing/other.md")).toBeNull();
  });
});

describe("parseSpec", () => {
  it("accepts a complete backend spec", () => {
    const s = parseSpec(fx("good-backend.md"));
    expect(s.domain).toBe("backend");
    expect(s.class).toBe("product");
    expect(s.openDecisionsEmpty).toBe(true);
    expect(s.listedPaths).toEqual(["backend/crates/thing/src/lib.rs", "schemas/thing.json"]);
    expect(s.missing).toEqual([]);
  });
  it("requires a UI design section for web-ui and reads the screens", () => {
    const s = parseSpec(fx("good-webui.md"));
    expect(s.missing).toEqual([]);
    expect(s.uiScreens).toEqual(["editor-empty", "editor-populated"]);
    const noUi = parseSpec(fx("good-webui.md").replace(/## 6\. UI design[\s\S]*?(?=## 7\.)/, ""));
    expect(noUi.missing).toContain("UI design section");
  });
  it("lists a missing section", () => {
    expect(parseSpec(fx("missing-verification.md")).missing).toContain("Verification section");
  });
  it("detects non-empty open decisions", () => {
    const s = parseSpec(fx("open-decisions.md"));
    expect(s.openDecisionsEmpty).toBe(false);
    expect(s.missing).toContain("Open decisions must be empty");
  });
  it("matches headings without numbers (review focus 1)", () => {
    expect(parseSpec(fx("unnumbered.md")).missing).toEqual([]);
  });
  it("parses the real spec 001", () => {
    const s = parseSpec(readFileSync(join(import.meta.dirname, "..", "..", "..", "specs", "001-scheduler-core", "spec.md"), "utf8"));
    expect(s.domain).toBe("automation");
    expect(s.class).toBe("tooling");
    expect(s.missing).toEqual([]);
    expect(s.listedPaths).toContain("tools/scheduler/");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/spec.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`tools/scheduler/src/spec/link.ts`:

```ts
const SPEC_LINE = /^Spec:\s*(specs\/\d{3}-[a-z0-9][a-z0-9-]*\/spec\.md)\s*$/m;

/** The spec path an issue body names, or null. Only `specs/NNN-slug/spec.md` is accepted. */
export function specPathFromIssueBody(body: string): string | null {
  const m = SPEC_LINE.exec(body);
  return m ? m[1] : null;
}
```

`tools/scheduler/src/spec/parse.ts`:

```ts
export type RequiredSection =
  | "goal"
  | "out-of-scope"
  | "acceptance-criteria"
  | "interfaces"
  | "verification"
  | "ui-design"
  | "open-decisions";

export interface ParsedSpec {
  status: string | null;
  class: string | null;
  domain: string | null;
  derivesFrom: boolean;
  sections: Record<RequiredSection, boolean>;
  openDecisionsEmpty: boolean;
  uiScreens: string[];
  listedPaths: string[];
  missing: string[];
}

const HEADINGS: Record<RequiredSection, RegExp> = {
  goal: /^goal$/i,
  "out-of-scope": /^out of scope$/i,
  "acceptance-criteria": /^acceptance criteria$/i,
  interfaces: /^interfaces and files$/i,
  verification: /^verification$/i,
  "ui-design": /^ui design$/i,
  "open-decisions": /^open decisions$/i,
};

const UI_DOMAINS = new Set(["web-ui", "widget"]);

interface Section {
  key: RequiredSection | null;
  body: string;
}

function splitSections(text: string): Section[] {
  const out: Section[] = [];
  const lines = text.split("\n");
  let current: Section | null = null;
  for (const line of lines) {
    const h = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    if (h) {
      const title = h[1];
      const key = (Object.keys(HEADINGS) as RequiredSection[]).find((k) => HEADINGS[k].test(title)) ?? null;
      current = { key, body: "" };
      out.push(current);
    } else if (current) current.body += line + "\n";
  }
  return out;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

export function parseSpec(text: string): ParsedSpec {
  const sections = splitSections(text);
  const has = (k: RequiredSection) => sections.some((s) => s.key === k);
  const body = (k: RequiredSection) => sections.find((s) => s.key === k)?.body ?? "";

  const status = firstMatch(text, /^Status:\s*(.+)$/m);
  const cls = firstMatch(text, /^Class:\s*([a-z-]+)/m);
  const domain = firstMatch(text, /Domain:\s*([a-z-]+)/m);
  const derivesFrom = /^Derives from:/m.test(text);

  const open = body("open-decisions").replace(/\s+/g, " ").trim().toLowerCase();
  const openDecisionsEmpty = has("open-decisions") && (open === "" || open === "none" || open === "none.");

  const uiScreens = (firstMatch(body("ui-design"), /^Screens:\s*(.+)$/m) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const listedPaths = [...body("interfaces").matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1])
    .filter((p) => /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.*@-]+)*\/?$/.test(p) && (p.includes("/") || p.includes(".")));

  const missing: string[] = [];
  if (!status) missing.push("Status line");
  if (!cls || !domain) missing.push("Class and domain line");
  if (!derivesFrom) missing.push("Derives from line");
  const required: [RequiredSection, string][] = [
    ["goal", "Goal section"],
    ["out-of-scope", "Out of scope section"],
    ["acceptance-criteria", "Acceptance criteria section"],
    ["interfaces", "Interfaces and files section"],
    ["verification", "Verification section"],
    ["open-decisions", "Open decisions section"],
  ];
  for (const [k, label] of required) if (!has(k)) missing.push(label);
  if (has("acceptance-criteria") && !/AC-\d+\./.test(body("acceptance-criteria"))) missing.push("numbered AC-n criteria");
  if (domain && UI_DOMAINS.has(domain)) {
    if (!has("ui-design")) missing.push("UI design section");
    else if (uiScreens.length === 0) missing.push("UI design Screens: list");
  } else if (has("ui-design")) missing.push("UI design section present for a non-UI domain");
  if (has("open-decisions") && !openDecisionsEmpty) missing.push("Open decisions must be empty");

  return {
    status,
    class: cls,
    domain,
    derivesFrom,
    sections: {
      goal: has("goal"),
      "out-of-scope": has("out-of-scope"),
      "acceptance-criteria": has("acceptance-criteria"),
      interfaces: has("interfaces"),
      verification: has("verification"),
      "ui-design": has("ui-design"),
      "open-decisions": has("open-decisions"),
    },
    openDecisionsEmpty,
    uiScreens,
    listedPaths,
    missing,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/spec.test.ts`
Expected: 9 passed. If the real spec 001 test fails on `listedPaths`, check that section 15 of the spec still writes paths in backticks; adjust the fixture expectation only if the spec itself changed.

- [ ] **Step 6: Commit**

```bash
git add tools/scheduler/src/spec tools/scheduler/test/spec.test.ts tools/scheduler/test/fixtures/specs
git commit -m "scheduler: issue spec link and spec field-set parser (spec section 10)"
```

---

### Task 5: Stage definitions, prompt rendering, profiles, and the committed agents/ content

**Files:**
- Create: `tools/scheduler/src/stages/definition.ts`
- Create: `tools/scheduler/src/stages/prompt.ts`
- Create: `tools/scheduler/src/profiles/resolve.ts`
- Create: `agents/stages/plan.md`, `agents/stages/implement.md`, `agents/stages/review.md`, `agents/stages/fix.md`
- Create: `agents/sensitive-paths.txt`
- Create: `agents/profiles/backend/profile.yaml`, `agents/profiles/backend/instructions.md`, `agents/profiles/backend/skills/.gitkeep`
- Create: `agents/profiles/security/profile.yaml`, `agents/profiles/security/instructions.md`, `agents/profiles/security/review-criteria.md`
- Test: `tools/scheduler/test/stages.test.ts`, `tools/scheduler/test/profiles.test.ts`

**Interfaces:**
- Produces: `parseStageDefinition(markdown: string): StageDefinition` (throws on a missing or invalid field), `loadStageDefinitions(dir: string): Record<AgentStageName, StageDefinition>`.
- Produces: `renderPrompt(template: string, input: StageInput): string` where `StageInput` matches `schemas/scheduler/stage-input.json`:
  ```ts
  interface StageInput {
    issue: { number: number; title: string; body: string };
    spec: string;
    plan?: PlanResult;
    pr?: { number: number; head_sha: string; url: string };
    ci?: string;
    findings?: string;
    fix_input?: string;
    result_path: string;
    profile_instructions: string;
  }
  ```
  Placeholders: `{{issue}}` (number, title, body), `{{spec}}`, `{{plan}}` (JSON), `{{pr}}` (number, sha, url), `{{ci}}`, `{{findings}}`, `{{fix_input}}`, `{{result_path}}`, `{{profile_instructions}}`. An unknown placeholder throws.
- Produces: `resolveProfile(agentsDir: string, name: string): Profile` (type from Task 1). `listProfiles(agentsDir): string[]`.
- Produces: `readSensitiveGlobs(agentsDir: string): string[]`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/stages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { loadStageDefinitions, parseStageDefinition } from "../src/stages/definition.ts";
import { renderPrompt } from "../src/stages/prompt.ts";

const minimal = `---
name: review
kind: agent
harness: claude
model: claude-fable-5-1
tier: strong
bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: review-result
---
Review {{issue}} and write {{result_path}}.
`;

describe("parseStageDefinition", () => {
  it("parses frontmatter and body", () => {
    const d = parseStageDefinition(minimal);
    expect(d.name).toBe("review");
    expect(d.bounds).toEqual({ timeout_min: 40, max_turns: 150, max_cost_usd: 6 });
    expect(d.prompt.trim()).toBe("Review {{issue}} and write {{result_path}}.");
  });
  it("rejects a fallback on a strong-tier stage (AC-25)", () => {
    expect(() => parseStageDefinition(minimal.replace("tier: strong", "tier: strong\nfallback: claude-opus-5-5"))).toThrow(/fallback/);
  });
  it("rejects a missing bounds field", () => {
    expect(() => parseStageDefinition(minimal.replace("max_cost_usd: 6", "x: 1"))).toThrow(/bounds/);
  });
  it("rejects an unknown harness", () => {
    expect(() => parseStageDefinition(minimal.replace("harness: claude", "harness: codex"))).toThrow(/harness/);
  });
});

describe("committed stage definitions", () => {
  it("load all four v0 stages with the spec's tiers", () => {
    const d = loadStageDefinitions(`${agentsDir}/stages`);
    expect(Object.keys(d).sort()).toEqual(["fix", "implement", "plan", "review"]);
    expect(d.plan.tier).toBe("strong");
    expect(d.review.tier).toBe("strong");
    expect(d.implement.tier).toBe("standard");
    expect(d.fix.tier).toBe("standard");
    expect(d.plan.output).toBe("plan-result");
    expect(d.review.output).toBe("review-result");
    for (const s of Object.values(d)) expect(s.prompt).toContain("{{result_path}}");
  });
});

describe("renderPrompt", () => {
  const input = {
    issue: { number: 7, title: "Add thing", body: "Spec: specs/010-thing/spec.md" },
    spec: "# spec",
    result_path: "/tmp/r.json",
    profile_instructions: "Use cargo.",
  };
  it("fills placeholders", () => {
    const out = renderPrompt("Issue #{{issue}}\n{{spec}}\n{{profile_instructions}}\n-> {{result_path}}", input);
    expect(out).toContain("#7 Add thing");
    expect(out).toContain("Spec: specs/010-thing/spec.md");
    expect(out).toContain("# spec");
    expect(out).toContain("Use cargo.");
    expect(out).toContain("-> /tmp/r.json");
  });
  it("renders plan as JSON and empty optionals as (none)", () => {
    const out = renderPrompt("{{plan}} | {{ci}}", { ...input, plan: { verdict: "ready", domain: "backend", tasks: [] } });
    expect(out).toContain('"verdict": "ready"');
    expect(out).toContain("| (none)");
  });
  it("throws on an unknown placeholder", () => {
    expect(() => renderPrompt("{{nope}}", input)).toThrow(/unknown placeholder/);
  });
});
```

`tools/scheduler/test/profiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { listProfiles, readSensitiveGlobs, resolveProfile } from "../src/profiles/resolve.ts";

describe("profiles", () => {
  it("lists the committed v0 profiles", () => {
    expect(listProfiles(agentsDir)).toEqual(["backend", "security"]);
  });
  it("resolves backend with its skills dir, instructions and tools", () => {
    const p = resolveProfile(agentsDir, "backend");
    expect(p.skillsDir.endsWith("agents/profiles/backend/skills")).toBe(true);
    expect(p.instructions.length).toBeGreaterThan(10);
    expect(p.tools).toContain("Bash");
  });
  it("resolves security with review criteria", () => {
    const p = resolveProfile(agentsDir, "security");
    expect(p.reviewCriteria).toMatch(/sensitive/i);
  });
  it("throws on an unknown profile", () => {
    expect(() => resolveProfile(agentsDir, "nope")).toThrow(/unknown profile/);
  });
  it("reads the sensitive path globs", () => {
    const g = readSensitiveGlobs(agentsDir);
    expect(g).toContain("tools/scheduler/");
    expect(g).toContain("agents/");
    expect(g).toContain(".github/");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/stages.test.ts tools/scheduler/test/profiles.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the committed agents content**

`agents/sensitive-paths.txt`:

```
# Globs, one per line, matched against repo-relative paths (process-spec section 5).
# dir/ matches everything under dir; * within a segment; ** across segments.
backend/**/auth/**
backend/**/sandbox/**
backend/**/provisioning/**
backend/**/relay/**
firmware/**/provisioning/**
firmware/**/wasm/**
tools/scheduler/
agents/
.github/
```

`agents/profiles/backend/profile.yaml`:

```yaml
name: backend
tools: [Read, Edit, Write, Bash, Glob, Grep]
credential_hook: null
review_criteria: null
```

`agents/profiles/backend/instructions.md`:

```markdown
Backend profile (default). Rust workspace under `backend/`, TypeScript tools under `tools/`.
Run `pnpm test` from the repo root before writing your result. Do not touch files outside
the plan's file scope; lockfiles and `schemas/` are the only exceptions. Record anything
you notice but must not fix as a finding in your result, then continue with your task.
```

`agents/profiles/backend/skills/.gitkeep`: empty file.

`agents/profiles/security/profile.yaml`:

```yaml
name: security
tools: [Read, Glob, Grep, Bash]
credential_hook: null
review_criteria: review-criteria.md
```

`agents/profiles/security/instructions.md`:

```markdown
Security review profile. You are reviewing a change that touches a sensitive path
(auth, the WASM sandbox host, provisioning, the relay, the automation itself, or CI).
Judge only against the criteria file provided. Any finding blocks merge until the
maintainer looks, so cite the acceptance criterion or rule and give a concrete scenario.
```

`agents/profiles/security/review-criteria.md`:

```markdown
# Security review criteria for sensitive paths

1. No secret, token or private key is written to the repository, a log, a comment, or a prompt.
2. Authority checks are in code, not prompts: anything that grants, lists or claims work keys on
   the App bot identity or the maintainer, never on free text.
3. New network listeners, outbound calls or shell execution are listed in the spec's Interfaces section.
4. Input from GitHub (issue bodies, comments, PR titles) is treated as data, never executed or interpolated into commands.
5. Changes under `tools/scheduler/`, `agents/` or `.github/` do not weaken a gate, a bound, or a label rule of spec 001.
```

`agents/stages/plan.md`:

```markdown
---
name: plan
kind: agent
harness: claude
model: claude-fable-5-1
tier: strong
effort: high
bounds: { timeout_min: 30, max_turns: 80, max_cost_usd: 5 }
permission: no-prompt
worktree: issue
profile: none
input: stage-input
output: plan-result
---
You are the plan stage of the panelator pipeline. Nobody will answer questions; the
scheduler reads only the result file.

Issue {{issue}}

Spec:
{{spec}}

{{profile_instructions}}

Produce an ordered list of implementation tasks, each with the exact repo-relative files
it will create or modify. Classify the issue's domain as one of backend, web-ui, widget,
firmware, infra. If the spec cannot be implemented as written, set verdict to spec_gap and
list precise questions for the maintainer instead of guessing.

Write the JSON result to {{result_path}} with the shape
{ "verdict": "ready" | "spec_gap", "domain": "...", "tasks": [{ "id": "T1", "description": "...", "files": ["..."] }], "questions": ["..."], "findings": [] }
and nothing else. Do not modify files in the repository.
```

`agents/stages/implement.md`:

```markdown
---
name: implement
kind: agent
harness: claude
model: claude-sonnet-5-5
fallback: openai/gpt-6.1-sol
tier: standard
effort: medium
bounds: { timeout_min: 90, max_turns: 300, max_cost_usd: 10 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: implement-result
---
You are the implement stage of the panelator pipeline, working in a git worktree on a
branch for this issue. Nobody will answer questions.

Issue {{issue}}

Spec:
{{spec}}

Plan (your file scope; do not touch files outside it except lockfiles and schemas/):
{{plan}}

{{profile_instructions}}

Implement every task in the plan, test-first, committing as you go. Run `pnpm test` from
the repo root before you finish. Then push the branch and open a pull request with `gh pr create`
whose body starts with "Closes #<issue>". Write the JSON result to {{result_path}}:
{ "pr_number": <n>, "head_sha": "<40 hex>", "tasks_done": ["T1", ...], "findings": [] }
```

`agents/stages/review.md`:

```markdown
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
You are the review stage of the panelator pipeline, in a fresh session. Judge the pull
request against the spec's acceptance criteria and the repository's rules only.

Issue {{issue}}

Spec:
{{spec}}

Plan:
{{plan}}

Pull request: {{pr}}

CI summary:
{{ci}}

{{profile_instructions}}

Every finding must cite an acceptance criterion (AC-n) or a repository rule (rule:<where>)
and give a concrete failure scenario with file and line. Style preferences are not findings.
Verdict is approve, changes_requested, or escalate (use escalate when the spec itself is
wrong or the change needs the maintainer). Write the JSON result to {{result_path}}:
{ "verdict": "...", "findings_on_pr": [{ "criterion": "AC-3", "file": "...", "line": 12, "scenario": "..." }], "declined_to_judge": [], "findings": [] }
Do not modify files.
```

`agents/stages/fix.md`:

```markdown
---
name: fix
kind: agent
harness: claude
model: claude-sonnet-5-5
fallback: openai/gpt-6.1-sol
tier: standard
effort: medium
bounds: { timeout_min: 60, max_turns: 200, max_cost_usd: 8 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: fix-result
---
You are the fix stage of the panelator pipeline, in the issue's worktree on its PR branch.
Nobody will answer questions.

Issue {{issue}}

Spec:
{{spec}}

Plan (file scope):
{{plan}}

Pull request: {{pr}}

What to fix:
{{fix_input}}

{{profile_instructions}}

Address each item, run `pnpm test` from the repo root, commit and push. Write the JSON
result to {{result_path}}: { "head_sha": "<40 hex>", "addressed": [0, 1], "findings": [] }
where addressed lists the indices of the items you resolved.
```

- [ ] **Step 4: Implement definition, prompt and profile modules**

`tools/scheduler/src/stages/definition.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isBounds, type AgentStageName, type StageDefinition } from "../types.ts";

const STAGES: AgentStageName[] = ["plan", "implement", "review", "fix"];

export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error("stage definition: missing YAML frontmatter");
  return { frontmatter: m[1], body: m[2] };
}

export function parseStageDefinition(markdown: string): StageDefinition {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fm = parse(frontmatter) as Record<string, unknown>;
  const req = (k: string): string => {
    const v = fm[k];
    if (typeof v !== "string" || !v) throw new Error(`stage definition: ${k} is required`);
    return v;
  };
  const name = req("name");
  if (!STAGES.includes(name as AgentStageName)) throw new Error(`stage definition: unknown stage name ${name}`);
  if (req("kind") !== "agent") throw new Error("stage definition: kind must be agent");
  const harness = req("harness");
  if (harness !== "claude" && harness !== "pi") throw new Error(`stage definition: harness must be claude or pi, got ${harness}`);
  const tier = req("tier");
  if (tier !== "strong" && tier !== "standard") throw new Error("stage definition: tier must be strong or standard");
  if (!isBounds(fm.bounds)) throw new Error("stage definition: bounds needs timeout_min, max_turns, max_cost_usd");
  if (req("permission") !== "no-prompt") throw new Error("stage definition: permission must be no-prompt");
  const worktree = req("worktree");
  if (worktree !== "issue" && worktree !== "fresh") throw new Error("stage definition: worktree must be issue or fresh");
  const fallback = typeof fm.fallback === "string" ? fm.fallback : undefined;
  if (fallback && tier === "strong") throw new Error("stage definition: a strong-tier stage may not name a fallback (AC-25)");
  return {
    name: name as AgentStageName,
    kind: "agent",
    harness,
    model: req("model"),
    fallback,
    tier,
    effort: typeof fm.effort === "string" ? fm.effort : undefined,
    bounds: fm.bounds,
    permission: "no-prompt",
    worktree,
    profile: req("profile"),
    input: req("input"),
    output: req("output"),
    prompt: body,
  };
}

export function loadStageDefinitions(dir: string): Record<AgentStageName, StageDefinition> {
  const out = {} as Record<AgentStageName, StageDefinition>;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const d = parseStageDefinition(readFileSync(join(dir, f), "utf8"));
    out[d.name] = d;
  }
  for (const s of STAGES) if (!out[s]) throw new Error(`stage definition missing: ${s}`);
  return out;
}
```

`tools/scheduler/src/stages/prompt.ts`:

```ts
import type { PlanResult } from "../types.ts";

export interface StageInput {
  issue: { number: number; title: string; body: string };
  spec: string;
  plan?: PlanResult;
  pr?: { number: number; head_sha: string; url: string };
  ci?: string;
  findings?: string;
  fix_input?: string;
  result_path: string;
  profile_instructions: string;
}

const NONE = "(none)";

export function renderPrompt(template: string, input: StageInput): string {
  const values: Record<string, string> = {
    issue: `#${input.issue.number} ${input.issue.title}\n\n${input.issue.body}`,
    spec: input.spec,
    plan: input.plan ? JSON.stringify(input.plan, null, 2) : NONE,
    pr: input.pr ? `#${input.pr.number} ${input.pr.head_sha} ${input.pr.url}` : NONE,
    ci: input.ci ?? NONE,
    findings: input.findings ?? NONE,
    fix_input: input.fix_input ?? NONE,
    result_path: input.result_path,
    profile_instructions: input.profile_instructions,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder {{${key}}}`);
    return values[key];
  });
}
```

`tools/scheduler/src/profiles/resolve.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Profile } from "../types.ts";

export function listProfiles(agentsDir: string): string[] {
  return readdirSync(join(agentsDir, "profiles"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function resolveProfile(agentsDir: string, name: string): Profile {
  const dir = join(agentsDir, "profiles", name);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !existsSync(join(dir, "profile.yaml"))) throw new Error(`unknown profile: ${name}`);
  const y = parse(readFileSync(join(dir, "profile.yaml"), "utf8")) as Record<string, unknown>;
  const tools = Array.isArray(y.tools) ? (y.tools as string[]) : [];
  const criteriaFile = typeof y.review_criteria === "string" ? y.review_criteria : null;
  return {
    name,
    dir,
    skillsDir: join(dir, "skills"),
    instructions: existsSync(join(dir, "instructions.md")) ? readFileSync(join(dir, "instructions.md"), "utf8") : "",
    tools,
    credentialHook: typeof y.credential_hook === "string" ? y.credential_hook : undefined,
    reviewCriteria: criteriaFile ? readFileSync(join(dir, criteriaFile), "utf8") : undefined,
  };
}

export function readSensitiveGlobs(agentsDir: string): string[] {
  return readFileSync(join(agentsDir, "sensitive-paths.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm vitest run tools/scheduler/test/stages.test.ts tools/scheduler/test/profiles.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 13 passed; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add agents tools/scheduler/src/stages tools/scheduler/src/profiles tools/scheduler/test/stages.test.ts tools/scheduler/test/profiles.test.ts
git commit -m "scheduler: stage definitions, prompt rendering, profiles and committed agents/ content (spec sections 6, 8, 9)"
```

---

### Task 6: Gates

**Files:**
- Create: `tools/scheduler/src/gates/types.ts`, `authority.ts`, `validated.ts`, `spec-present.ts`, `ui-design.ts`, `automation-change.ts`, `ready.ts`, `scope.ts`, `sensitive.ts`, `fix-loop.ts`, `liveness.ts`, `index.ts`
- Test: `tools/scheduler/test/gates.test.ts`

**Interfaces:**
- Produces (`gates/types.ts`):
  ```ts
  type GateResult =
    | { ok: true }
    | { ok: false; action: "ignore"; reason: string }
    | { ok: false; action: "label"; label: string; reason: string };
  ```
- Produces one function per gate, all pure:
  - `authorityGate(issue: IssueData, appBot: string, maintainer: string, validatedLabel: string): GateResult`
  - `validatedGate(issue: IssueData, validatedLabel: string): GateResult`
  - `specPresentGate(issue: IssueData, specText: string | null): GateResult` (label `needs-spec`)
  - `uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult` (label `needs-design`)
  - `automationChangeGate(issue: IssueData, spec: ParsedSpec, maintainer: string, validatedLabel: string): GateResult`
  - `readyGate(plan: PlanResult): GateResult` (label `needs-clarification`)
  - `scopeGate(diffFiles: string[], plan: PlanResult, spec: ParsedSpec, sensitiveGlobs: string[]): { ok: true } | { ok: false; violations: string[] }`
  - `isSensitive(diffFiles: string[], sensitiveGlobs: string[]): string[]` (the matching paths)
  - `fixLoopGate(fixes: number): GateResult` (label `needs-human` when `fixes >= 2`, spec section 5)
  - `livenessGate(lastActivityAt: string, runInFlight: boolean, now: Date, hours: number): GateResult` (`action: "ignore"` with reason `liveness expired` when expired; callers release)
  - `latestLabelActor(events: LabelEvent[], label: string): string | null` (actor of the most recent `labeled` event for the label, or null if the label was unlabeled after it)

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/gates.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityGate, automationChangeGate, fixLoopGate, isSensitive, latestLabelActor, livenessGate,
  readyGate, scopeGate, specPresentGate, uiDesignGate, validatedGate,
} from "../src/gates/index.ts";
import { parseSpec } from "../src/spec/parse.ts";
import type { IssueData, LabelEvent, PlanResult } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const ME = "adam26davidson";
const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "specs", n), "utf8");

function issue(over: Partial<IssueData> = {}): IssueData {
  return {
    number: 5, title: "t", author: BOT, body: "Spec: specs/010-thing/spec.md", labels: ["validated"],
    labelEvents: [{ label: "validated", actor: BOT, action: "labeled", at: "2026-10-01T00:00:00Z" }],
    createdAt: "2026-10-01T00:00:00Z", ...over,
  };
}
const ev = (label: string, actor: string, action: LabelEvent["action"], at: string): LabelEvent => ({ label, actor, action, at });

describe("latestLabelActor", () => {
  it("returns the actor of the most recent add, ignoring an earlier add that was removed (review focus 3)", () => {
    const events = [ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2"), ev("validated", BOT, "labeled", "3")];
    expect(latestLabelActor(events, "validated")).toBe(BOT);
  });
  it("returns null when the label was removed last", () => {
    expect(latestLabelActor([ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2")], "validated")).toBeNull();
  });
});

describe("authorityGate (AC-6, section 4.3)", () => {
  it("passes a bot-authored issue", () => {
    expect(authorityGate(issue(), BOT, ME, "validated")).toEqual({ ok: true });
  });
  it("passes a maintainer-authored issue when the maintainer added validated", () => {
    const i = issue({ author: ME, labelEvents: [ev("validated", ME, "labeled", "1")] });
    expect(authorityGate(i, BOT, ME, "validated").ok).toBe(true);
  });
  it("ignores a community issue even with validated added by someone else", () => {
    const i = issue({ author: "stranger", labelEvents: [ev("validated", "stranger", "labeled", "1")] });
    const r = authorityGate(i, BOT, ME, "validated");
    expect(r).toEqual({ ok: false, action: "ignore", reason: expect.stringMatching(/authority/) });
  });
});

describe("validatedGate (AC-6)", () => {
  it("ignores without the label and never labels", () => {
    expect(validatedGate(issue({ labels: [] }), "validated")).toEqual({ ok: false, action: "ignore", reason: expect.any(String) });
  });
  it("passes with it", () => {
    expect(validatedGate(issue(), "validated").ok).toBe(true);
  });
});

describe("specPresentGate (AC-7)", () => {
  it("labels needs-spec when the body has no link", () => {
    const r = specPresentGate(issue({ body: "hi" }), null);
    expect(r).toMatchObject({ ok: false, action: "label", label: "needs-spec" });
  });
  it("labels needs-spec naming the missing part when the file is absent on main", () => {
    const r = specPresentGate(issue(), null);
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/not found on main/) });
  });
  it("labels needs-spec naming open decisions", () => {
    const r = specPresentGate(issue(), fx("open-decisions.md"));
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Open decisions/) });
  });
  it("passes a complete spec", () => {
    expect(specPresentGate(issue(), fx("good-backend.md"))).toEqual({ ok: true });
  });
});

describe("uiDesignGate (AC-8)", () => {
  const web = parseSpec(fx("good-webui.md"));
  it("passes a non-UI domain with no design dir", () => {
    expect(uiDesignGate(parseSpec(fx("good-backend.md")), [])).toEqual({ ok: true });
  });
  it("labels needs-design on an empty design dir", () => {
    expect(uiDesignGate(web, [])).toMatchObject({ ok: false, label: "needs-design" });
  });
  it("requires a story or token prototype and a PNG per screen", () => {
    expect(uiDesignGate(web, ["editor.stories.tsx", "editor-empty.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/editor-populated\.png/) });
    expect(uiDesignGate(web, ["editor-empty.png", "editor-populated.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/story or token prototype/) });
    expect(uiDesignGate(web, ["tokens.html", "editor-empty.png", "editor-populated.png"])).toEqual({ ok: true });
  });
});

describe("automationChangeGate (AC-12)", () => {
  const spec001 = parseSpec(readFileSync(join(import.meta.dirname, "..", "..", "..", "specs", "001-scheduler-core", "spec.md"), "utf8"));
  it("ignores when validated was set by the bot", () => {
    expect(automationChangeGate(issue(), spec001, ME, "validated")).toMatchObject({ ok: false, action: "ignore" });
  });
  it("passes when validated was set by the maintainer", () => {
    expect(automationChangeGate(issue({ labelEvents: [ev("validated", ME, "labeled", "1")] }), spec001, ME, "validated")).toEqual({ ok: true });
  });
  it("passes a non-automation spec regardless", () => {
    expect(automationChangeGate(issue(), parseSpec(fx("good-backend.md")), ME, "validated")).toEqual({ ok: true });
  });
});

describe("readyGate (AC-9)", () => {
  it("labels needs-clarification on spec_gap with the questions in the reason", () => {
    const r = readyGate({ verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which port?", "Which db?"] });
    expect(r).toMatchObject({ ok: false, label: "needs-clarification", reason: expect.stringContaining("Which db?") });
  });
  it("passes ready", () => {
    expect(readyGate({ verdict: "ready", domain: "backend", tasks: [] })).toEqual({ ok: true });
  });
});

describe("scopeGate (AC-10) and isSensitive (AC-11)", () => {
  const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["backend/a.rs", "backend/auth/x.rs"] }] };
  const spec = parseSpec(fx("good-backend.md"));
  const globs = ["backend/**/auth/**", "tools/scheduler/"];
  it("passes a diff inside the plan plus lockfiles and schemas", () => {
    expect(scopeGate(["backend/a.rs", "pnpm-lock.yaml", "Cargo.lock", "schemas/x.json"], plan, spec, globs)).toEqual({ ok: true });
  });
  it("lists files outside scope", () => {
    expect(scopeGate(["backend/a.rs", "web/x.ts"], plan, spec, globs)).toEqual({ ok: false, violations: ["web/x.ts: outside plan file scope"] });
  });
  it("fails a sensitive file not listed in the spec even when it is in the plan (review focus 4)", () => {
    expect(scopeGate(["backend/auth/x.rs"], plan, spec, globs)).toEqual({ ok: false, violations: ["backend/auth/x.rs: sensitive path not listed in the spec"] });
  });
  it("allows a sensitive file the spec lists", () => {
    const s = parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `backend/auth/`"));
    expect(scopeGate(["backend/auth/x.rs"], plan, s, globs)).toEqual({ ok: true });
  });
  it("treats a plan directory entry as a prefix", () => {
    const p: PlanResult = { ...plan, tasks: [{ id: "T1", description: "d", files: ["tools/scheduler/src/"] }] };
    expect(scopeGate(["tools/scheduler/src/x.ts"], p, parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `tools/scheduler/`")), globs)).toEqual({ ok: true });
  });
  it("isSensitive returns the matching paths", () => {
    expect(isSensitive(["web/a.ts", "tools/scheduler/src/x.ts"], globs)).toEqual(["tools/scheduler/src/x.ts"]);
  });
});

describe("fixLoopGate (AC-13)", () => {
  it("passes 0 and 1, labels needs-human at 2", () => {
    expect(fixLoopGate(0).ok).toBe(true);
    expect(fixLoopGate(1).ok).toBe(true);
    expect(fixLoopGate(2)).toMatchObject({ ok: false, label: "needs-human" });
  });
});

describe("livenessGate (AC-15)", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("passes while a run is in flight regardless of age", () => {
    expect(livenessGate("2026-10-12T00:00:00Z", true, now, 2).ok).toBe(true);
  });
  it("passes with recent activity", () => {
    expect(livenessGate("2026-10-12T11:00:00Z", false, now, 2).ok).toBe(true);
  });
  it("expires after the window with no run", () => {
    expect(livenessGate("2026-10-12T09:59:00Z", false, now, 2)).toMatchObject({ ok: false, action: "ignore", reason: expect.stringMatching(/liveness/) });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/gates.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the gates**

`tools/scheduler/src/gates/types.ts`:

```ts
export type GateResult =
  | { ok: true }
  | { ok: false; action: "ignore"; reason: string }
  | { ok: false; action: "label"; label: string; reason: string };

export const pass: GateResult = { ok: true };
export const ignore = (reason: string): GateResult => ({ ok: false, action: "ignore", reason });
export const label = (label: string, reason: string): GateResult => ({ ok: false, action: "label", label, reason });
```

`tools/scheduler/src/gates/authority.ts`:

```ts
import type { IssueData, LabelEvent } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

/** Actor of the most recent add of `label`, or null if it is not currently applied by the timeline. */
export function latestLabelActor(events: LabelEvent[], label: string): string | null {
  let actor: string | null = null;
  for (const e of events) {
    if (e.label !== label) continue;
    actor = e.action === "labeled" ? e.actor : null;
  }
  return actor;
}

export function authorityGate(issue: IssueData, appBot: string, maintainer: string, validatedLabel: string): GateResult {
  if (issue.author === appBot) return pass;
  if (latestLabelActor(issue.labelEvents, validatedLabel) === maintainer) return pass;
  return ignore(`authority: author ${issue.author} is not the App and ${validatedLabel} was not set by the maintainer`);
}
```

`tools/scheduler/src/gates/validated.ts`:

```ts
import type { IssueData } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

export function validatedGate(issue: IssueData, validatedLabel: string): GateResult {
  return issue.labels.includes(validatedLabel) ? pass : ignore(`${validatedLabel} label absent`);
}
```

`tools/scheduler/src/gates/spec-present.ts`:

```ts
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_SPEC = "needs-spec";

/** `specText` is the file content on main, or null when it does not exist there. */
export function specPresentGate(issue: IssueData, specText: string | null): GateResult {
  const path = specPathFromIssueBody(issue.body);
  if (!path) return label(NEEDS_SPEC, "issue body has no `Spec: specs/NNN-slug/spec.md` line");
  if (specText === null) return label(NEEDS_SPEC, `${path} not found on main`);
  const parsed = parseSpec(specText);
  if (parsed.missing.length) return label(NEEDS_SPEC, `${path} is missing: ${parsed.missing.join("; ")}`);
  return pass;
}
```

`tools/scheduler/src/gates/ui-design.ts`:

```ts
import type { ParsedSpec } from "../spec/parse.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_DESIGN = "needs-design";
const UI_DOMAINS = new Set(["web-ui", "widget"]);

/** `designFiles` are the file names under the spec's design/ directory. */
export function uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult {
  if (!spec.domain || !UI_DOMAINS.has(spec.domain)) return pass;
  const problems: string[] = [];
  const hasStory = designFiles.some((f) => /\.stories\.(tsx?|jsx?|mdx)$/.test(f));
  const hasTokenPrototype = designFiles.some((f) => /^tokens.*\.html$/.test(f) || /-prototype\.html$/.test(f));
  if (!hasStory && !hasTokenPrototype) problems.push("no story or token prototype in design/");
  for (const screen of spec.uiScreens) if (!designFiles.includes(`${screen}.png`)) problems.push(`missing ${screen}.png`);
  return problems.length ? label(NEEDS_DESIGN, problems.join("; ")) : pass;
}
```

`tools/scheduler/src/gates/automation-change.ts`:

```ts
import type { ParsedSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { latestLabelActor } from "./authority.ts";
import { ignore, pass, type GateResult } from "./types.ts";

const AUTOMATION_PREFIXES = ["tools/scheduler/", "agents/"];

export function touchesAutomation(spec: ParsedSpec): boolean {
  return spec.listedPaths.some((p) => AUTOMATION_PREFIXES.some((a) => p === a || p.startsWith(a) || a.startsWith(p + "/") ));
}

export function automationChangeGate(issue: IssueData, spec: ParsedSpec, maintainer: string, validatedLabel: string): GateResult {
  if (!touchesAutomation(spec)) return pass;
  if (latestLabelActor(issue.labelEvents, validatedLabel) === maintainer) return pass;
  return ignore(`automation change: ${validatedLabel} must be set by the maintainer (process-spec section 5)`);
}
```

`tools/scheduler/src/gates/ready.ts`:

```ts
import type { PlanResult } from "../types.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_CLARIFICATION = "needs-clarification";

export function readyGate(plan: PlanResult): GateResult {
  if (plan.verdict === "ready") return pass;
  const qs = (plan.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n");
  return label(NEEDS_CLARIFICATION, `The plan stage found gaps in the spec:\n${qs}`);
}
```

`tools/scheduler/src/gates/sensitive.ts`:

```ts
import { matchesAny } from "../glob.ts";

export function isSensitive(diffFiles: string[], sensitiveGlobs: string[]): string[] {
  return diffFiles.filter((f) => matchesAny(f, sensitiveGlobs));
}
```

`tools/scheduler/src/gates/scope.ts`:

```ts
import type { ParsedSpec } from "../spec/parse.ts";
import type { PlanResult } from "../types.ts";
import { isSensitive } from "./sensitive.ts";

const ALWAYS_ALLOWED = [/^schemas\//, /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$/];

function inScope(file: string, scope: string[]): boolean {
  return scope.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s));
}

export type ScopeResult = { ok: true } | { ok: false; violations: string[] };

export function scopeGate(diffFiles: string[], plan: PlanResult, spec: ParsedSpec, sensitiveGlobs: string[]): ScopeResult {
  const scope = plan.tasks.flatMap((t) => t.files);
  const violations: string[] = [];
  for (const f of diffFiles) {
    const allowed = ALWAYS_ALLOWED.some((re) => re.test(f));
    if (!allowed && !inScope(f, scope)) violations.push(`${f}: outside plan file scope`);
  }
  for (const f of isSensitive(diffFiles, sensitiveGlobs)) {
    if (!inScope(f, spec.listedPaths)) violations.push(`${f}: sensitive path not listed in the spec`);
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}
```

`tools/scheduler/src/gates/fix-loop.ts`:

```ts
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_HUMAN = "needs-human";
export const MAX_FIXES = 2;

export function fixLoopGate(fixes: number): GateResult {
  return fixes >= MAX_FIXES ? label(NEEDS_HUMAN, `fix loop limit reached (${fixes} fixes)`) : pass;
}
```

`tools/scheduler/src/gates/liveness.ts`:

```ts
import { ignore, pass, type GateResult } from "./types.ts";

export function livenessGate(lastActivityAt: string, runInFlight: boolean, now: Date, hours: number): GateResult {
  if (runInFlight) return pass;
  const ageMs = now.getTime() - new Date(lastActivityAt).getTime();
  return ageMs > hours * 3_600_000 ? ignore(`liveness expired: no activity for ${hours} h`) : pass;
}
```

`tools/scheduler/src/gates/index.ts`:

```ts
export * from "./types.ts";
export { authorityGate, latestLabelActor } from "./authority.ts";
export { validatedGate } from "./validated.ts";
export { specPresentGate, NEEDS_SPEC } from "./spec-present.ts";
export { uiDesignGate, NEEDS_DESIGN } from "./ui-design.ts";
export { automationChangeGate, touchesAutomation } from "./automation-change.ts";
export { readyGate, NEEDS_CLARIFICATION } from "./ready.ts";
export { scopeGate, type ScopeResult } from "./scope.ts";
export { isSensitive } from "./sensitive.ts";
export { fixLoopGate, NEEDS_HUMAN, MAX_FIXES } from "./fix-loop.ts";
export { livenessGate } from "./liveness.ts";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/gates.test.ts`
Expected: all pass (29 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/gates tools/scheduler/test/gates.test.ts
git commit -m "scheduler: gates of spec section 8 as pure tested functions (AC-6 to AC-15)"
```

---

### Task 7: Shortlist ranking and selection

**Files:**
- Create: `tools/scheduler/src/shortlist/rank.ts`
- Create: `tools/scheduler/src/shortlist/select.ts`
- Test: `tools/scheduler/test/shortlist.test.ts`

**Interfaces:**
- Produces: `rankIssues(issues: IssueData[], labels: Config["labels"], recent: { feature: number; debt: number }): IssueData[]`. Order: `priority` label first; then whichever of feature or debt is behind the 2:1 ratio (feature if `feature < 2 * debt`, else debt), with the other class after; ties oldest first. `recent` counts merged PRs by class, supplied by the caller (plan 3 reads it from the usage/claim history; v0 may pass zeros, which yields feature first).
- Produces: `selectEligible(issues: IssueData[], ctx: SelectContext): { eligible: IssueData[]; decisions: Decision[] }` with
  ```ts
  interface SelectContext {
    appBot: string; maintainer: string; labels: Config["labels"];
    claimed: Set<number>;                       // issues with a live claim
    readSpec: (path: string) => string | null;  // content on main or null
    listDesign: (specPath: string) => string[]; // file names in design/ beside the spec
  }
  interface Decision { issue: number; gate: string; result: GateResult }
  ```
  `decisions` holds one entry per issue per gate that did not pass (so the caller can label and notify), and an entry with gate `"eligible"` and `{ ok: true }` for each eligible issue.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/shortlist.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rankIssues } from "../src/shortlist/rank.ts";
import { selectEligible } from "../src/shortlist/select.ts";
import type { IssueData } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const ME = "adam26davidson";
const labels = { validated: "validated", claim: "in-progress", priority: "priority", feature_classes: ["class:product"], debt_classes: ["class:bug", "class:tooling", "class:dependency"] };
const good = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");

function issue(n: number, over: Partial<IssueData> = {}): IssueData {
  return {
    number: n, title: `i${n}`, author: BOT, body: "Spec: specs/010-thing/spec.md", labels: ["validated", "class:product"],
    labelEvents: [{ label: "validated", actor: BOT, action: "labeled", at: "2026-10-01T00:00:00Z" }],
    createdAt: `2026-10-0${n}T00:00:00Z`, ...over,
  };
}

describe("rankIssues", () => {
  it("puts priority first, then the class behind the 2:1 ratio, then oldest", () => {
    const a = issue(1, { labels: ["validated", "class:bug"] });
    const b = issue(2, { labels: ["validated", "class:product"] });
    const c = issue(3, { labels: ["validated", "class:product", "priority"] });
    const d = issue(4, { labels: ["validated", "class:product"] });
    // 2 features and 0 debt merged recently: debt is behind, so bug comes before products
    expect(rankIssues([a, b, c, d], labels, { feature: 2, debt: 0 }).map((i) => i.number)).toEqual([3, 1, 2, 4]);
    // 0 and 0: feature first
    expect(rankIssues([a, b, c, d], labels, { feature: 0, debt: 0 }).map((i) => i.number)).toEqual([3, 2, 4, 1]);
  });
});

describe("selectEligible", () => {
  const ctx = {
    appBot: BOT, maintainer: ME, labels, claimed: new Set<number>(),
    readSpec: (p: string) => (p === "specs/010-thing/spec.md" ? good : null),
    listDesign: () => [],
  };
  it("returns eligible issues and a decision per failed gate", () => {
    const ok = issue(1);
    const noLabel = issue(2, { labels: [] });
    const badSpec = issue(3, { body: "Spec: specs/999-none/spec.md" });
    const claimed = issue(4);
    const blocked = issue(5, { labels: ["validated", "blocked"] });
    const needs = issue(6, { labels: ["validated", "needs-human"] });
    const r = selectEligible([ok, noLabel, badSpec, claimed, blocked, needs], { ...ctx, claimed: new Set([4]) });
    expect(r.eligible.map((i) => i.number)).toEqual([1]);
    expect(r.decisions.find((d) => d.issue === 3)).toMatchObject({ gate: "spec-present", result: { ok: false, label: "needs-spec" } });
    expect(r.decisions.find((d) => d.issue === 2)).toMatchObject({ gate: "validated", result: { action: "ignore" } });
    expect(r.decisions.filter((d) => d.issue === 4)).toEqual([]);
    expect(r.decisions.filter((d) => d.issue === 5)).toEqual([]);
    expect(r.decisions.filter((d) => d.issue === 6)).toEqual([]);
  });
  it("stops at the first failing gate per issue", () => {
    const r = selectEligible([issue(9, { author: "stranger", labels: [] })], ctx);
    expect(r.decisions.filter((d) => d.issue === 9)).toHaveLength(1);
    expect(r.decisions[0].gate).toBe("authority");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/shortlist.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/shortlist/rank.ts`:

```ts
import type { Config } from "../config.ts";
import type { IssueData } from "../types.ts";

export interface RecentMerges {
  feature: number;
  debt: number;
}

export function classOf(issue: IssueData, labels: Config["labels"]): "feature" | "debt" | "none" {
  if (issue.labels.some((l) => labels.feature_classes.includes(l))) return "feature";
  if (issue.labels.some((l) => labels.debt_classes.includes(l))) return "debt";
  return "none";
}

/** Priority label first, then the class behind the 2:1 feature:debt ratio, then oldest (spec section 7). */
export function rankIssues(issues: IssueData[], labels: Config["labels"], recent: RecentMerges): IssueData[] {
  // Prefer feature until two features have been merged per debt item already merged plus the one about to be.
  const preferred: "feature" | "debt" = recent.feature < 2 * (recent.debt + 1) ? "feature" : "debt";
  const rank = (i: IssueData) => {
    if (i.labels.includes(labels.priority)) return 0;
    const c = classOf(i, labels);
    if (c === preferred) return 1;
    if (c === "none") return 3;
    return 2;
  };
  return [...issues].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
}
```

Note the ratio rule: with `feature: 2, debt: 0`, `2 < 2` is false, so debt is preferred; with zeros or `feature: 1, debt: 0`, feature is preferred; with `feature: 4, debt: 1`, `4 < 4` is false, so debt. That is "2:1 feature to debt".

`tools/scheduler/src/shortlist/select.ts`:

```ts
import type { Config } from "../config.ts";
import {
  authorityGate, automationChangeGate, specPresentGate, uiDesignGate, validatedGate, type GateResult,
} from "../gates/index.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";

export interface SelectContext {
  appBot: string;
  maintainer: string;
  labels: Config["labels"];
  claimed: Set<number>;
  readSpec: (path: string) => string | null;
  listDesign: (specPath: string) => string[];
}

export interface Decision {
  issue: number;
  gate: string;
  result: GateResult;
}

const SKIP_PREFIX = "needs-";
const BLOCKED = "blocked";

export function selectEligible(issues: IssueData[], ctx: SelectContext): { eligible: IssueData[]; decisions: Decision[] } {
  const eligible: IssueData[] = [];
  const decisions: Decision[] = [];
  for (const issue of issues) {
    if (ctx.claimed.has(issue.number)) continue;
    if (issue.labels.includes(ctx.labels.claim) || issue.labels.includes(BLOCKED) || issue.labels.some((l) => l.startsWith(SKIP_PREFIX))) continue;

    const steps: [string, () => GateResult][] = [
      ["authority", () => authorityGate(issue, ctx.appBot, ctx.maintainer, ctx.labels.validated)],
      ["validated", () => validatedGate(issue, ctx.labels.validated)],
      ["spec-present", () => specPresentGate(issue, specText(issue, ctx))],
      ["ui-design", () => uiDesignGate(parsedSpec(issue, ctx), ctx.listDesign(specPathFromIssueBody(issue.body) ?? ""))],
      ["automation-change", () => automationChangeGate(issue, parsedSpec(issue, ctx), ctx.maintainer, ctx.labels.validated)],
    ];
    let failed = false;
    for (const [gate, run] of steps) {
      const result = run();
      if (!result.ok) {
        decisions.push({ issue: issue.number, gate, result });
        failed = true;
        break;
      }
    }
    if (!failed) {
      decisions.push({ issue: issue.number, gate: "eligible", result: { ok: true } });
      eligible.push(issue);
    }
  }
  return { eligible, decisions };
}

function specText(issue: IssueData, ctx: SelectContext): string | null {
  const p = specPathFromIssueBody(issue.body);
  return p ? ctx.readSpec(p) : null;
}

function parsedSpec(issue: IssueData, ctx: SelectContext) {
  // Only reached after specPresentGate passed, so the text exists and parses clean.
  return parseSpec(specText(issue, ctx) ?? "");
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/shortlist.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/shortlist tools/scheduler/test/shortlist.test.ts
git commit -m "scheduler: shortlist ranking and eligibility selection (spec section 7)"
```

---

### Task 8: Chain state machine

**Files:**
- Create: `tools/scheduler/src/chain/types.ts`
- Create: `tools/scheduler/src/chain/machine.ts`
- Test: `tools/scheduler/test/chain.test.ts`

**Interfaces:**
- Produces (`chain/types.ts`):
  ```ts
  type ChainStage = "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge" | "done" | "released" | "needs-human" | "waiting";
  interface ChainState {
    issue: number;
    stage: ChainStage;
    attempt: number;            // attempt number of the current agent stage (1-based)
    fixes: number;              // fix stages run so far
    scopeViolations: number;    // times scope failed on this issue
    planFailures: number;
    implementFailures: number;
    securityFinding: boolean;   // once true, merge never runs (AC-11)
    pr: { number: number; head_sha: string } | null;
    plan: PlanResult | null;
    pendingFixInput: string | null;
    postponedUntil: string | null;   // AC-25 strong-tier postponement
  }
  type ChainEvent =
    | { type: "start" }
    | { type: "stage_ok"; stage: "plan"; result: PlanResult }
    | { type: "stage_ok"; stage: "implement"; result: ImplementResult; scope: ScopeResult }
    | { type: "stage_ok"; stage: "fix"; result: FixResult; scope: ScopeResult }
    | { type: "stage_ok"; stage: "review"; result: ReviewResult; security: boolean }
    | { type: "stage_failed"; stage: AgentStageName; reason: string; postpone?: boolean }
    | { type: "checks"; status: "green" | "failed" | "pending"; log?: string; sensitive: boolean }
    | { type: "merge_result"; status: "merged" | "not_mergeable"; detail?: string }
    | { type: "rebase_conflict"; detail: string }
    | { type: "liveness_expired" };
  type Action =
    | { type: "run_stage"; stage: AgentStageName; attempt: number; fixInput?: string; profile?: "security" }
    | { type: "verify" }
    | { type: "merge" }
    | { type: "label"; add: string[]; remove: string[] }
    | { type: "comment"; text: string }
    | { type: "notify"; gate: string; label: string; text: string }
    | { type: "release"; reason: string; savePatch: boolean }
    | { type: "wait"; seconds: number }
    | { type: "done" };
  ```
- Produces: `initialChainState(issue: number): ChainState`, `transition(state: ChainState, event: ChainEvent): { state: ChainState; actions: Action[] }`. Pure; throws on an event that is not valid in the current stage.

The transition table is spec section 5. Exact rules the machine encodes:

| stage | event | next | actions |
|---|---|---|---|
| claimed | start | plan | run_stage plan attempt 1 |
| plan | stage_ok ready | implement | run_stage implement 1 |
| plan | stage_ok spec_gap | released | comment questions; label +needs-clarification -in-progress; notify; release (no patch) |
| plan | stage_failed, planFailures 0 | plan | run_stage plan attempt 2 |
| plan | stage_failed, planFailures 1 | needs-human | label +needs-human -in-progress; notify; release |
| plan/implement/review/fix | stage_failed postpone | waiting | wait 1800 (claim held, AC-25 strong tier) |
| waiting | start | previous stage | run_stage same attempt |
| implement | stage_ok scope ok | verify | verify |
| implement | stage_ok scope violation, scopeViolations 0 | fix | run_stage fix with violations as fixInput |
| implement | stage_ok scope violation, scopeViolations 1 | needs-human | label; notify; release |
| implement | stage_failed, implementFailures 0 | implement | run_stage implement attempt 2 |
| implement | stage_failed, implementFailures 1 | needs-human | label; notify; release |
| verify | checks green | review | run_stage review (profile security if sensitive) |
| verify | checks failed | fix | run_stage fix with log |
| verify | checks pending | verify | wait 60 |
| review | approve, no security finding | merge | merge |
| review | approve, security finding (event.security && findings_on_pr non-empty), or any finding when security | needs-human | label +security-review +needs-human; notify |
| review | changes_requested, fixes < 2 | fix | run_stage fix with findings |
| review | changes_requested, fixes = 2 | needs-human | label; notify; release |
| review | escalate | needs-human | label; notify; release |
| fix | stage_ok scope ok | verify | verify (fixes += 1) |
| fix | stage_ok scope violation | as implement | |
| fix | stage_failed | needs-human | (fix has no retry) |
| merge | merged | done | label -in-progress; done |
| merge | not_mergeable | fix | run_stage fix with detail |
| any agent stage | rebase_conflict | fix | run_stage fix with conflict |
| any | liveness_expired | released | comment; label -in-progress; release savePatch |

`securityFinding` becomes true the moment a security-profile review returns any `findings_on_pr`; afterwards every path that would reach `merge` goes to needs-human instead (AC-11 "even if a later review approves").

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/chain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialChainState, transition } from "../src/chain/machine.ts";
import type { ChainState } from "../src/chain/types.ts";
import type { ImplementResult, PlanResult, ReviewResult } from "../src/types.ts";

const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }] };
const impl: ImplementResult = { pr_number: 3, head_sha: "b".repeat(40), tasks_done: ["T1"] };
const approve: ReviewResult = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
const changes: ReviewResult = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.ts", line: 1, scenario: "s" }], declined_to_judge: [] };

function at(stage: ChainState["stage"], over: Partial<ChainState> = {}): ChainState {
  return { ...initialChainState(1), stage, ...over };
}

describe("chain: happy path", () => {
  it("claimed -> plan -> implement -> verify -> review -> merge -> done", () => {
    let s = initialChainState(1);
    let r = transition(s, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    r = transition(r.state, { type: "stage_ok", stage: "plan", result: plan });
    expect(r.state.stage).toBe("implement");
    expect(r.state.plan).toEqual(plan);
    r = transition(r.state, { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } });
    expect(r.state.stage).toBe("verify");
    expect(r.state.pr).toEqual({ number: 3, head_sha: "b".repeat(40) });
    expect(r.actions).toEqual([{ type: "verify" }]);
    r = transition(r.state, { type: "checks", status: "green", sensitive: false });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    r = transition(r.state, { type: "stage_ok", stage: "review", result: approve, security: false });
    expect(r.actions).toEqual([{ type: "merge" }]);
    r = transition(r.state, { type: "merge_result", status: "merged" });
    expect(r.state.stage).toBe("done");
    expect(r.actions).toContainEqual({ type: "label", add: [], remove: ["in-progress"] });
    expect(r.actions).toContainEqual({ type: "done" });
  });
});

describe("chain: plan outcomes (AC-9)", () => {
  it("spec_gap posts one comment, labels needs-clarification, releases without a patch", () => {
    const r = transition(at("plan"), { type: "stage_ok", stage: "plan", result: { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Q1", "Q2"] } });
    expect(r.state.stage).toBe("released");
    expect(r.actions.filter((a) => a.type === "comment")).toHaveLength(1);
    expect(r.actions).toContainEqual({ type: "label", add: ["needs-clarification"], remove: ["in-progress"] });
    expect(r.actions).toContainEqual(expect.objectContaining({ type: "notify", gate: "ready", label: "needs-clarification" }));
    expect(r.actions).toContainEqual({ type: "release", reason: "spec_gap", savePatch: false });
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
  });
  it("retries a failed plan once, then needs-human", () => {
    const r1 = transition(at("plan"), { type: "stage_failed", stage: "plan", reason: "timeout" });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 2 }]);
    const r2 = transition(r1.state, { type: "stage_failed", stage: "plan", reason: "timeout" });
    expect(r2.state.stage).toBe("needs-human");
    expect(r2.actions).toContainEqual({ type: "label", add: ["needs-human"], remove: ["in-progress"] });
  });
});

describe("chain: scope (AC-10)", () => {
  it("first violation goes to fix with the violations as input; second goes to needs-human", () => {
    const r1 = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(r1.state.stage).toBe("fix");
    expect(r1.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("web/x.ts") });
    const r2 = transition(r1.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(r2.state.stage).toBe("needs-human");
  });
});

describe("chain: verify (AC-14)", () => {
  it("pending waits, failed goes to fix with the log, green starts review", () => {
    expect(transition(at("verify"), { type: "checks", status: "pending", sensitive: false }).actions).toEqual([{ type: "wait", seconds: 60 }]);
    const f = transition(at("verify"), { type: "checks", status: "failed", log: "FAIL x.test.ts", sensitive: false });
    expect(f.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("FAIL x.test.ts") });
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true });
    expect(g.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
});

describe("chain: review (AC-11, AC-13)", () => {
  it("changes_requested goes to fix twice, then needs-human", () => {
    let s = at("review");
    let r = transition(s, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("fix");
    r = transition(r.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: true } });
    expect(r.state.fixes).toBe(1);
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("fix");
    r = transition(r.state, { type: "stage_ok", stage: "fix", result: { head_sha: "d".repeat(40), addressed: [0] }, scope: { ok: true } });
    expect(r.state.fixes).toBe(2);
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("needs-human");
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
  });
  it("a security finding blocks merge even after a later approval", () => {
    const r1 = transition(at("review"), { type: "stage_ok", stage: "review", result: changes, security: true });
    expect(r1.state.stage).toBe("needs-human");
    expect(r1.state.securityFinding).toBe(true);
    expect(r1.actions).toContainEqual({ type: "label", add: ["security-review", "needs-human"], remove: [] });
    const r2 = transition({ ...r1.state, stage: "review" }, { type: "stage_ok", stage: "review", result: approve, security: true });
    expect(r2.state.stage).toBe("needs-human");
    expect(r2.actions.find((a) => a.type === "merge")).toBeUndefined();
  });
  it("escalate goes to needs-human", () => {
    const r = transition(at("review"), { type: "stage_ok", stage: "review", result: { ...approve, verdict: "escalate" }, security: false });
    expect(r.state.stage).toBe("needs-human");
  });
});

describe("chain: merge, rebase, liveness, postpone", () => {
  it("not mergeable goes to fix", () => {
    const r = transition(at("merge"), { type: "merge_result", status: "not_mergeable", detail: "conflict in a.ts" });
    expect(r.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("conflict in a.ts") });
  });
  it("rebase conflict before any stage goes to fix (AC-16)", () => {
    const r = transition(at("review"), { type: "rebase_conflict", detail: "CONFLICT a.ts" });
    expect(r.state.stage).toBe("fix");
  });
  it("liveness expiry releases with a patch and a comment (AC-15)", () => {
    const r = transition(at("implement"), { type: "liveness_expired" });
    expect(r.state.stage).toBe("released");
    expect(r.actions).toContainEqual({ type: "release", reason: "liveness expired", savePatch: true });
    expect(r.actions.filter((a) => a.type === "comment")).toHaveLength(1);
  });
  it("postponed strong-tier stage waits with the claim held and resumes the same stage (AC-25)", () => {
    const r1 = transition(at("review"), { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(r1.state.stage).toBe("waiting");
    expect(r1.actions).toEqual([{ type: "wait", seconds: 1800 }]);
    const r2 = transition(r1.state, { type: "start" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
  });
  it("throws on an event that is invalid for the stage", () => {
    expect(() => transition(at("plan"), { type: "merge_result", status: "merged" })).toThrow(/invalid/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/chain.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/chain/types.ts`:

```ts
import type { ScopeResult } from "../gates/scope.ts";
import type { AgentStageName, FixResult, ImplementResult, PlanResult, ReviewResult } from "../types.ts";

export type ChainStage =
  | "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge"
  | "done" | "released" | "needs-human" | "waiting";

export interface ChainState {
  issue: number;
  stage: ChainStage;
  attempt: number;
  fixes: number;
  scopeViolations: number;
  planFailures: number;
  implementFailures: number;
  securityFinding: boolean;
  pr: { number: number; head_sha: string } | null;
  plan: PlanResult | null;
  pendingFixInput: string | null;
  postponedUntil: string | null;
  resumeStage: AgentStageName | null;
}

export type ChainEvent =
  | { type: "start" }
  | { type: "stage_ok"; stage: "plan"; result: PlanResult }
  | { type: "stage_ok"; stage: "implement"; result: ImplementResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "fix"; result: FixResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "review"; result: ReviewResult; security: boolean }
  | { type: "stage_failed"; stage: AgentStageName; reason: string; postpone?: boolean }
  | { type: "checks"; status: "green" | "failed" | "pending"; log?: string; sensitive: boolean }
  | { type: "merge_result"; status: "merged" | "not_mergeable"; detail?: string }
  | { type: "rebase_conflict"; detail: string }
  | { type: "liveness_expired" };

export type Action =
  | { type: "run_stage"; stage: AgentStageName; attempt: number; fixInput?: string; profile?: "security" }
  | { type: "verify" }
  | { type: "merge" }
  | { type: "label"; add: string[]; remove: string[] }
  | { type: "comment"; text: string }
  | { type: "notify"; gate: string; label: string; text: string }
  | { type: "release"; reason: string; savePatch: boolean }
  | { type: "wait"; seconds: number }
  | { type: "done" };
```

`tools/scheduler/src/chain/machine.ts`:

```ts
import { MAX_FIXES, NEEDS_CLARIFICATION, NEEDS_HUMAN, readyGate } from "../gates/index.ts";
import type { AgentStageName } from "../types.ts";
import type { Action, ChainEvent, ChainState } from "./types.ts";

export const CLAIM_LABEL = "in-progress";
export const SECURITY_REVIEW_LABEL = "security-review";
export const PENDING_WAIT_S = 60;
export const POSTPONE_WAIT_S = 1800;

export function initialChainState(issue: number): ChainState {
  return {
    issue, stage: "claimed", attempt: 1, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0,
    securityFinding: false, pr: null, plan: null, pendingFixInput: null, postponedUntil: null, resumeStage: null,
  };
}

type Step = { state: ChainState; actions: Action[] };

function invalid(state: ChainState, event: ChainEvent): never {
  throw new Error(`invalid event ${event.type} in stage ${state.stage} (issue ${state.issue})`);
}

function run(state: ChainState, stage: AgentStageName, extra: Partial<Extract<Action, { type: "run_stage" }>> = {}, patch: Partial<ChainState> = {}): Step {
  const attempt = patch.attempt ?? 1;
  return { state: { ...state, ...patch, stage, attempt, resumeStage: null }, actions: [{ type: "run_stage", stage, attempt, ...extra }] };
}

function needsHuman(state: ChainState, gate: string, text: string, extraLabels: string[] = []): Step {
  return {
    state: { ...state, stage: "needs-human" },
    actions: [
      { type: "label", add: [...extraLabels, NEEDS_HUMAN], remove: [CLAIM_LABEL] },
      { type: "notify", gate, label: NEEDS_HUMAN, text },
      { type: "release", reason: gate, savePatch: false },
    ],
  };
}

function toFix(state: ChainState, fixInput: string, patch: Partial<ChainState> = {}): Step {
  return run(state, "fix", { fixInput }, { ...patch, pendingFixInput: fixInput });
}

export function transition(state: ChainState, event: ChainEvent): Step {
  if (event.type === "liveness_expired") {
    return {
      state: { ...state, stage: "released" },
      actions: [
        { type: "comment", text: "Claim released: no run in flight and no activity for the liveness window. Uncommitted work was saved as a patch in the scheduler state directory." },
        { type: "label", add: [], remove: [CLAIM_LABEL] },
        { type: "release", reason: "liveness expired", savePatch: true },
      ],
    };
  }
  if (event.type === "rebase_conflict") {
    if (!["plan", "implement", "review", "fix", "verify", "merge"].includes(state.stage)) invalid(state, event);
    return toFix(state, `Rebase onto main conflicted:\n${event.detail}`);
  }
  if (event.type === "stage_failed") {
    if (event.postpone) {
      if (!["plan", "implement", "review", "fix"].includes(state.stage)) invalid(state, event);
      return { state: { ...state, stage: "waiting", resumeStage: event.stage, postponedUntil: null }, actions: [{ type: "wait", seconds: POSTPONE_WAIT_S }] };
    }
    switch (state.stage) {
      case "plan":
        if (state.planFailures === 0) return run(state, "plan", {}, { planFailures: 1, attempt: 2 });
        return needsHuman(state, "plan", `plan failed twice: ${event.reason}`);
      case "implement":
        if (state.implementFailures === 0) return run(state, "implement", {}, { implementFailures: 1, attempt: 2 });
        return needsHuman(state, "implement", `implement failed twice: ${event.reason}`);
      case "review":
        if (state.attempt === 1) return run(state, "review", {}, { attempt: 2 });
        return needsHuman(state, "review", `review failed twice: ${event.reason}`);
      case "fix":
        return needsHuman(state, "fix", `fix failed: ${event.reason}`);
      default:
        invalid(state, event);
    }
  }

  switch (state.stage) {
    case "claimed":
      if (event.type === "start") return run(state, "plan");
      break;
    case "waiting":
      if (event.type === "start" && state.resumeStage) return run(state, state.resumeStage, state.resumeStage === "fix" && state.pendingFixInput ? { fixInput: state.pendingFixInput } : {}, { attempt: state.attempt });
      break;
    case "plan":
      if (event.type === "stage_ok" && event.stage === "plan") {
        const gate = readyGate(event.result);
        if (gate.ok) return run({ ...state, plan: event.result }, "implement");
        const reason = gate.action === "label" ? gate.reason : "spec gap";
        return {
          state: { ...state, stage: "released", plan: event.result },
          actions: [
            { type: "comment", text: reason },
            { type: "label", add: [NEEDS_CLARIFICATION], remove: [CLAIM_LABEL] },
            { type: "notify", gate: "ready", label: NEEDS_CLARIFICATION, text: reason },
            { type: "release", reason: "spec_gap", savePatch: false },
          ],
        };
      }
      break;
    case "implement":
    case "fix":
      if (event.type === "stage_ok" && (event.stage === "implement" || event.stage === "fix")) {
        const pr = event.stage === "implement"
          ? { number: event.result.pr_number, head_sha: event.result.head_sha }
          : state.pr ? { ...state.pr, head_sha: event.result.head_sha } : null;
        const fixes = event.stage === "fix" ? state.fixes + 1 : state.fixes;
        if (!event.scope.ok) {
          const text = `Diff touches files outside the plan's file scope:\n${event.scope.violations.map((v) => `- ${v}`).join("\n")}`;
          if (state.scopeViolations >= 1) return needsHuman({ ...state, pr, fixes }, "scope", text);
          return toFix({ ...state, pr, fixes }, text, { scopeViolations: 1 });
        }
        return { state: { ...state, stage: "verify", pr, fixes, pendingFixInput: null }, actions: [{ type: "verify" }] };
      }
      break;
    case "verify":
      if (event.type === "checks") {
        if (event.status === "pending") return { state, actions: [{ type: "wait", seconds: PENDING_WAIT_S }] };
        if (event.status === "failed") return toFix(state, `A required check failed:\n${event.log ?? "(no log excerpt)"}`);
        return run(state, "review", event.sensitive ? { profile: "security" } : {});
      }
      break;
    case "review":
      if (event.type === "stage_ok" && event.stage === "review") {
        const r = event.result;
        const securityHit = event.security && r.findings_on_pr.length > 0;
        if (securityHit) {
          return {
            state: { ...state, stage: "needs-human", securityFinding: true },
            actions: [
              { type: "label", add: [SECURITY_REVIEW_LABEL, NEEDS_HUMAN], remove: [] },
              { type: "notify", gate: "sensitive-path", label: NEEDS_HUMAN, text: `security review returned ${r.findings_on_pr.length} finding(s)` },
            ],
          };
        }
        if (r.verdict === "escalate") return needsHuman(state, "review", "review escalated to the maintainer");
        if (r.verdict === "approve") {
          if (state.securityFinding) return needsHuman(state, "sensitive-path", "an earlier security finding blocks merge");
          return { state: { ...state, stage: "merge" }, actions: [{ type: "merge" }] };
        }
        if (state.fixes >= MAX_FIXES) return needsHuman(state, "fix-loop", `changes requested after ${state.fixes} fixes`);
        const text = `Review requested changes:\n${r.findings_on_pr.map((f, i) => `${i}. [${f.criterion}] ${f.file}:${f.line} ${f.scenario}`).join("\n")}`;
        return toFix(state, text);
      }
      break;
    case "merge":
      if (event.type === "merge_result") {
        if (event.status === "merged") return { state: { ...state, stage: "done" }, actions: [{ type: "label", add: [], remove: [CLAIM_LABEL] }, { type: "done" }] };
        return toFix(state, `PR not mergeable:\n${event.detail ?? ""}`);
      }
      break;
    default:
      break;
  }
  invalid(state, event);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tools/scheduler/test/chain.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 14 passed; tsc clean. If tsc complains that `transition` lacks a return on some path, the final `invalid(...)` call is typed `never`; make sure every `case` ends in `break` or `return`.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/chain tools/scheduler/test/chain.test.ts
git commit -m "scheduler: chain state machine of spec section 5 (AC-9 to AC-16, AC-25)"
```

---

### Task 9: Notification interface, log implementation, rate limiting

**Files:**
- Create: `tools/scheduler/src/notify/types.ts`
- Create: `tools/scheduler/src/notify/log.ts`
- Create: `tools/scheduler/src/notify/rate-limit.ts`
- Test: `tools/scheduler/test/notify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Notification { issue: number; gate: string; label: string; text: string }
  interface Notifier { notify(n: Notification): Promise<void> }
  class LogNotifier implements Notifier { constructor(logPath: string) }   // appends one JSON line per notification
  function rateLimited(inner: Notifier, hours: number, clock: () => Date): Notifier & { sent: Map<string, number> }
  ```
  Identity key for rate limiting is `${issue}:${gate}:${label}` (AC-27 "identical notifications").

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/notify.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogNotifier } from "../src/notify/log.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import type { Notification, Notifier } from "../src/notify/types.ts";

const n: Notification = { issue: 4, gate: "spec-present", label: "needs-spec", text: "missing Verification section" };

describe("LogNotifier", () => {
  it("appends one JSON line per notification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    const p = join(dir, "service.log");
    const log = new LogNotifier(p);
    await log.notify(n);
    await log.notify({ ...n, issue: 5 });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "notify", issue: 4, gate: "spec-present", label: "needs-spec" });
  });
});

describe("rateLimited (AC-27)", () => {
  function recorder(): Notifier & { calls: Notification[] } {
    const calls: Notification[] = [];
    return { calls, notify: async (x) => { calls.push(x); } };
  }
  it("delivers once per identity within the window, then again after it", async () => {
    let now = new Date("2026-10-12T00:00:00Z");
    const inner = recorder();
    const rl = rateLimited(inner, 4, () => now);
    await rl.notify(n);
    await rl.notify({ ...n, text: "different text, same identity" });
    expect(inner.calls).toHaveLength(1);
    now = new Date("2026-10-12T03:59:00Z");
    await rl.notify(n);
    expect(inner.calls).toHaveLength(1);
    now = new Date("2026-10-12T04:01:00Z");
    await rl.notify(n);
    expect(inner.calls).toHaveLength(2);
  });
  it("treats a different issue, gate or label as a different identity", async () => {
    const inner = recorder();
    const rl = rateLimited(inner, 4, () => new Date());
    await rl.notify(n);
    await rl.notify({ ...n, issue: 9 });
    await rl.notify({ ...n, label: "needs-human" });
    expect(inner.calls).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/notify.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/notify/types.ts`:

```ts
export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}
```

`tools/scheduler/src/notify/log.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Notification, Notifier } from "./types.ts";

/** v0 implementation (spec section 15): one JSON line per notification in the service log. */
export class LogNotifier implements Notifier {
  readonly path: string;
  constructor(logPath: string) {
    this.path = logPath;
  }
  async notify(n: Notification): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ kind: "notify", at: new Date().toISOString(), ...n }) + "\n");
  }
}
```

`tools/scheduler/src/notify/rate-limit.ts`:

```ts
import type { Notification, Notifier } from "./types.ts";

export function identity(n: Notification): string {
  return `${n.issue}:${n.gate}:${n.label}`;
}

export function rateLimited(inner: Notifier, hours: number, clock: () => Date = () => new Date()): Notifier & { sent: Map<string, number> } {
  const sent = new Map<string, number>();
  const windowMs = hours * 3_600_000;
  return {
    sent,
    async notify(n) {
      const key = identity(n);
      const now = clock().getTime();
      const last = sent.get(key);
      if (last !== undefined && now - last < windowMs) return;
      sent.set(key, now);
      await inner.notify(n);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/notify.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/notify tools/scheduler/test/notify.test.ts
git commit -m "scheduler: notification interface, log notifier and 4-hour rate limit (AC-27)"
```

---

### Task 10: Decision interface stub and plan-1 wrap-up

**Files:**
- Create: `tools/scheduler/src/decide/types.ts`
- Create: `tools/scheduler/src/decide/client.ts`
- Test: `tools/scheduler/test/decide.test.ts`
- Modify: `README.md` (one line: first milestone)

**Interfaces:**
- Produces:
  ```ts
  interface DecideRequest { state: unknown; questions: { id: string; text: string; options?: string[] }[] }
  interface DecideResponse { answers: Record<string, string> }
  interface Decider { decide(req: DecideRequest): Promise<DecideResponse> }
  function systemOneDecider(baseUrl: string, key: string, fetchFn?: typeof fetch): Decider   // POST {baseUrl}/v1/systemone
  ```
  No caller in v0 (spec section 2, 15). The test injects `fetchFn`; nothing reaches the network.

- [ ] **Step 1: Write the failing test**

`tools/scheduler/test/decide.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { systemOneDecider } from "../src/decide/client.ts";

describe("systemOneDecider", () => {
  it("posts to /v1/systemone with the key and returns typed answers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ answers: { q1: "yes" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const d = systemOneDecider("https://decide.example", "k", fetchFn);
    const r = await d.decide({ state: { stage: "plan" }, questions: [{ id: "q1", text: "proceed?" }] });
    expect(r.answers.q1).toBe("yes");
    expect(calls[0].url).toBe("https://decide.example/v1/systemone");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });
  it("throws on a non-2xx response", async () => {
    const fetchFn = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(systemOneDecider("https://x", "k", fetchFn).decide({ state: {}, questions: [] })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/decide.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/decide/types.ts`:

```ts
export interface DecideQuestion {
  id: string;
  text: string;
  options?: string[];
}

export interface DecideRequest {
  state: unknown;
  questions: DecideQuestion[];
}

export interface DecideResponse {
  answers: Record<string, string>;
}

export interface Decider {
  decide(req: DecideRequest): Promise<DecideResponse>;
}
```

`tools/scheduler/src/decide/client.ts`:

```ts
import type { DecideRequest, DecideResponse, Decider } from "./types.ts";

/** Seam for a decision model (spec section 1, 15). No caller in v0. */
export function systemOneDecider(baseUrl: string, key: string, fetchFn: typeof fetch = fetch): Decider {
  return {
    async decide(req: DecideRequest): Promise<DecideResponse> {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`decide: HTTP ${res.status}`);
      const body = (await res.json()) as DecideResponse;
      if (!body || typeof body.answers !== "object") throw new Error("decide: malformed response");
      return body;
    },
  };
}
```

In `README.md`, change the line

```
Status: requirements settled, nothing built yet. First milestone is the widget
runtime spike (see the product spec, section 12).
```

to

```
Status: requirements settled. First milestone is the scheduler of spec 001
(`specs/001-scheduler-core/`), which then builds everything else; the widget
runtime spike (product spec, section 12) is the first product milestone.
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm -F @panelator/scheduler typecheck`
Expected: every test file in `tools/scheduler/test/` passes; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/decide tools/scheduler/test/decide.test.ts README.md
git commit -m "scheduler: decision interface stub for /v1/systemone; README milestone line"
```

---

## Self-review against the spec

- Section 4 modules covered here: `shortlist/` (Task 7), `gates/` (Task 6), `chain/` (Task 8), `stages/` (Task 5), `profiles/` (Task 5), `notify/` (Task 9), `decide/` (Task 10). Deferred to plan 2: `adapters/`, `runner/`, `state/`. Deferred to plan 3: `github/`, `service/`.
- Section 5 table: every row is a `transition` test in Task 8.
- Section 6 stage set, tiers, result schemas, "style nits rejected by schema": Tasks 2 and 5.
- Section 7 shortlist stub: Task 7 (the GitHub fetch with pagination assertion is plan 3).
- Section 8 gates: all rows except Bounds (plan 2, runner) and Freshness (plan 3, service) are in Task 6; Verify is a script stage (plan 3).
- Section 9 profiles: Task 5 ships `backend` and `security` with minimal content and the resolver.
- Section 10 field set: Task 4 parser; `specs/README.md` already describes the layout and needs no change.
- Section 15 files: `agents/*` and `schemas/scheduler/*` created; `bin/scheduler`, `systemd/`, `test/fixtures` recorded streams are plans 2 and 3.
- AC coverage in this plan: AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-15, AC-16 (machine side), AC-25 (definition rule and machine side), AC-27. The rest are in plans 2 and 3.
