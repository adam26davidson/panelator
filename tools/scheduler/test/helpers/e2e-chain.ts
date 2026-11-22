import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "octokit";
import { afterAll, expect } from "vitest";
import { GitHubClient } from "../../src/github/client.ts";
import type { StageRun } from "../../src/adapters/types.ts";
import { listClaims } from "../../src/state/claims.ts";
import { listPaused, type PausedRecord } from "../../src/state/paused.ts";
import type { Question } from "../../src/types.ts";
import type { StatePaths } from "../../src/state/paths.ts";
import { worldPaths, type ChainWorld } from "./e2e-routes.ts";
import { git } from "./repo-pair.ts";

// The shared setup of the e2e-*.test.ts files, split from one e2e.test.ts so vitest runs them in parallel (issue #360).

export const spec = readFileSync(join(import.meta.dirname, "..", "fixtures", "specs", "good-backend.md"), "utf8");
export const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };

// ---------------------------------------------------------------------------------------------------------------
// Spec 006 AC-28: the recorded chains for every escalation outcome. The real Scheduler, driver and machine, the fake
// adapter, and a mocked GitHub whose repository is a real bare origin (helpers/e2e-routes.ts).

export const PARENT = "docs/product-spec.md";
export const CHARTER = "# Charter\n\nThe root of the design tree.\n";
export const specOf = (extraPaths: string[] = []) =>
  spec.replace("Parent: docs/top.md", `Parent: ${PARENT}`).replace("- `schemas/thing.json`", ["- `schemas/thing.json`", ...extraPaths.map((p) => `- \`${p}\``)].join("\n"));
/** The repository on main: a charter, a top design listing the spec, and the spec (omitted with `spec: null`). */
export function repoFiles(o: { spec?: string | null } = {}): Record<string, string> {
  const files: Record<string, string> = {
    "a.txt": "a\n",
    "docs/charter.md": CHARTER,
    [PARENT]: `# Product spec\n\nParent: docs/charter.md\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n`,
  };
  const text = o.spec === undefined ? specOf() : o.spec;
  if (text !== null) files["specs/010-thing/spec.md"] = text;
  return files;
}

export const FAIL = undefined;
export const PLAN = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
export const APPROVE = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
export const CHANGES = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.txt", line: 1, scenario: "z is not produced" }], declined_to_judge: [] };
export const ask = (kind: Question["kind"], question: string): Question => ({
  kind, question, options: [{ label: "option 1", cost: "16 KB of RAM" }, { label: "option 2", cost: "a second flash partition" }], recommendation: "option 1",
});
export const ESCALATE = (q: Question) => ({ verdict: "escalate", findings_on_pr: [], declined_to_judge: [], escalation: q });
export const SEND = { verdict: "send", reasoning: "a trade-off only the maintainer can weigh" };

/** Stage scripts that do the agent's git work in the world `w()` (assigned once the world exists). */
export function agents(w: () => ChainWorld) {
  return {
    implement: (n: number, files: Record<string, string> = { "a.txt": `pr ${n}\n` }, check?: (run: StageRun) => void) => (run: StageRun) => {
      check?.(run);
      const sha = w().push(run, files);
      w().openPr(run, n, sha);
      return { pr_number: n, head_sha: sha, tasks_done: ["T1"] };
    },
    fix: (files: Record<string, string>) => (run: StageRun) => ({ head_sha: w().push(run, files, "fix"), addressed: [0] }),
    /** A fix recording the answers of the questions asked so far as an ADR carrying each mark (AC-18, TI1). */
    adr: (file = "docs/decisions/0001-x.md") => (run: StageRun) => {
      const marks = w().questions().map((q) => `(maintainer answer, question #${q.id})`).join(", ");
      return { head_sha: w().push(run, { [file]: `# Use option 1\n\nDecided by the maintainer ${marks}.\n` }, "adr"), addressed: [] };
    },
    spec: (n: number, files: Record<string, string>) => (run: StageRun) => {
      const sha = w().push(run, files, "spec");
      w().openPr(run, n, sha, "Spec revision for the thing");
      return { verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: n, head_sha: sha };
    },
  };
}

/** Nothing left over: no chain errors, no unmatched route, no claim, no paused record. */
export async function expectSettled(w: ChainWorld): Promise<void> {
  expect(w.logs.filter((r) => r.kind === "error")).toEqual([]);
  expect(w.gh.unmatched).toEqual([]);
  expect(await listClaims(w.paths)).toEqual([]);
  expect(await listPaused(w.paths)).toEqual([]);
}
export const inputsOf = (w: ChainWorld, stage: string) => w.adapter.runs.filter((r) => r.stage === stage).map((r) => r.input);
export const runsOf = (w: ChainWorld, stage: string) => w.adapter.runs.filter((r) => r.stage === stage);
export const patchesOf = (w: ChainWorld, kind: string) => readdirSync(w.paths.patches).filter((f) => f.startsWith("7-") && f.includes(`-${kind}`));
export const pausedRecord = (w: ChainWorld): PausedRecord => JSON.parse(readFileSync(join(w.paths.paused, "7.json"), "utf8"));
export const rev = (run: StageRun) => git(run.worktree, "rev-parse", "HEAD").trim();
/** Implement commits and pushes `issue-7` (and opens PR 9 when `pr`), then asks; `held` records the head it left. */
export function asksAfterPushing(w: () => ChainWorld, q: Question, held: { head: string }, pr = false) {
  return (run: StageRun) => {
    held.head = w().push(run, { "a.txt": "held work\n" }, "held");
    if (pr) w().openPr(run, 9, held.head);
    return { escalation: q };
  };
}
export const kinds = (w: ChainWorld, kind: string) => w.logs.filter((r) => r.kind === kind);
export const QUESTION_MARKER = /\n\n<!-- panelator-question:([0-9a-f-]{36}) -->$/;

// ---------------------------------------------------------------------------------------------------------------
// Spec 015 AC-12: the chain keeps its work through postponements and network outages.

/**
 * The world's GitHub behind a switchable network (`down` set: every request fails as a DNS failure does, or, with
 * `genuine`, answers 422), without Octokit's own retries, and a clock the test moves forward.
 */
export function network(w: ChainWorld) {
  const n = { down: false, genuine: false, offset: 0 };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (n.down && n.genuine) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422, headers: { "content-type": "application/json" } });
    if (n.down) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" }) });
    return w.gh.fetch(input, init);
  }) as typeof fetch;
  w.deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: fetchFn }, retry: { enabled: false } }), "o/r");
  w.deps.now = () => new Date(Date.now() + n.offset);
  return n;
}
export const serviceRecords = (w: ChainWorld) => readFileSync(w.paths.serviceLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

// ---------------------------------------------------------------------------------------------------------------
// Spec 026 AC-2 across files: e2e-event-kinds.test.ts checks that the recorded chains of all the e2e files together
// produce every event kind. Each e2e file leaves the state paths of its worlds in the run's temp root
// (helpers/test-tmpdir.ts), and vitest.config.ts runs the check after every other file has finished.

/** The e2e files whose worlds the event-kind check reads; the check fails when one of them left no record. */
export const E2E_FILES = ["e2e-1", "e2e-2", "e2e-3", "e2e-4", "e2e-5", "e2e-6", "e2e-7", "e2e-8", "e2e-9", "e2e-10"];
const worldsDir = () => join(tmpdir(), "e2e-worlds");

/** Called once at the top of each e2e file: after its last test, writes the state paths of the worlds it recorded. */
export function recordWorlds(file: string): void {
  afterAll(() => {
    mkdirSync(worldsDir(), { recursive: true });
    writeFileSync(join(worldsDir(), `${file}.json`), JSON.stringify(worldPaths));
  });
}

/** The state paths each e2e file recorded, by file name. */
export function recordedWorlds(): Record<string, StatePaths[]> {
  const out: Record<string, StatePaths[]> = {};
  if (!existsSync(worldsDir())) return out;
  for (const f of readdirSync(worldsDir()).filter((f) => f.endsWith(".json"))) out[f.slice(0, -".json".length)] = JSON.parse(readFileSync(join(worldsDir(), f), "utf8"));
  return out;
}
