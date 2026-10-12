# Spec 001, Plan 3 of 3: Service (GitHub App, chain driver, poll loop, systemd, AC-29)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the core (plan 1) and the runner (plan 2) into the long-lived service of spec section 14: GitHub App auth with token refresh, a GitHub client with full pagination and completeness assertion, the shortlist fetch, the chain driver that executes the state machine's actions, the poll loop with wake-on-exit, sleep detection, liveness, freshness and self-update, signals, the sleep inhibitor, the systemd unit, a recorded end-to-end test, and the one manual AC-29 run.

**Architecture:** `github/` wraps octokit with an injectable `fetch` so every test runs against a route-table mock. `chain/driver.ts` is the only place that turns `Action`s into side effects; it feeds events back into `transition`. `service/loop.ts` owns time: polls, wake-ups, sleep detection, liveness, freshness, signals. The binary wires config, state, adapters and the service together.

**Tech Stack:** octokit 5 (`App`, `Octokit`, paginate, graphql), node:crypto (test RSA keys), git CLI, systemd user units, vitest.

**Spec:** `specs/001-scheduler-core/spec.md`. Plans 1 and 2 (`plans/1-core.md`, `plans/2-runs.md`) must be complete first.

## Global Constraints

- Same as plans 1 and 2: pnpm, `pnpm test` from the root before done, commit on the given branch, no push, ESM TypeScript with `.ts` imports, `erasableSyntaxOnly`.
- No test touches the network (spec section 17). Every GitHub call in tests goes through the mock fetch in `test/helpers/mock-github.ts`.
- Agents never list anything from GitHub (process-spec 6.4): listing is done here, with full pagination and a completeness assertion against the server total, failing loudly when they disagree.
- The pipeline acts as the GitHub App, never as the maintainer (spec section 1).
- The claim label `in-progress` is applied and removed only by the scheduler (spec section 11). If GitHub and the state directory disagree, GitHub wins and the claim is stale.
- Self-restart exits with code 75 (`EX_TEMPFAIL`) so `Restart=on-failure` restarts it (spec section 14 names `on-failure`; a zero exit would not restart).

## Review Focus

1. **An issue list where the REST pagination returns fewer items than the GraphQL `totalCount`** (the predecessor's silent truncation): `listOpenIssues` must throw, and the tick must log the error and skip claiming, never work from a short list. Pinned in Task 3.
2. **A claim file on disk whose issue no longer carries `in-progress` on GitHub** (someone removed it by hand): the claim is stale, GitHub wins, the claim is dropped and the worktree's uncommitted work is saved as a patch. Pinned in Task 7.
3. **The laptop sleeps mid-stage; the stage process is killed by the timeout while asleep**: the chain must see `timeout`, not hang; on wake the loop ticks once within one interval. Pinned in Task 7 (sleep detection) and plan 2 (timeout).
4. **A SIGTERM while a stage is in flight**: no new polls, the stage finishes or times out, `stopped` trailer written, exit; a claim with a run id but no live process on next start is handled by liveness. Pinned in Task 7.
5. **The installation token expires while a stage is running**: the refresher rewrites `token.json` every 50 minutes independent of stages, and the gh shim reads the file on each call, so a long stage sees the new token. Pinned in Task 2 (refresh timing) and plan 2 (shim reads per call).

## File structure

```
tools/scheduler/
  src/
    github/auth.ts          createAppClient(cfg, fetchFn) -> { octokit, installationToken(), startTokenRefresh(paths) }
    github/client.ts        GitHubClient: issues (paginate + assert), timeline label events, labels, comments, PR, checks, job log, merge
    github/types.ts         CheckSummary, PullRequestInfo
    shortlist/fetch.ts      buildSelectContext(repoDir, cfg, claims) ; recentMerges
    state/merges.ts         appendMerge, recentMerges (feeds the 2:1 ratio)
    chain/driver.ts         step(deps, claim) -> {claim, status}; driveChain(deps, claim)
    service/git.ts          fetchMain, fastForwardMain(repo) -> {moved, changedPaths}
    service/inhibit.ts      SleepInhibitor (systemd-inhibit wrapper, injectable)
    service/log.ts          ServiceLog: tick/stopped/error trailers (JSONL)
    service/loop.ts         Scheduler: tick(), run(), stop()
  bin/scheduler.ts          entry point
  systemd/panelator-scheduler.service
  test/helpers/mock-github.ts   route-table fetch mock
  test/helpers/repo-pair.ts     bare origin + checkout (from plan 2's worktree test)
  test/auth.test.ts, client.test.ts, fetch.test.ts, driver.test.ts, loop.test.ts, e2e.test.ts
.github/workflows/ci.yml   required check for the verify stage (prerequisite, see Task 1)
dev-logs/2026-MM-DD-spec-001-ac29.md   written by hand in Task 10
```

---

### Task 1: Manual prerequisites: GitHub App, labels, CI workflow

Steps 1 to 3 and 5 are manual and done by the maintainer once; the checkboxes are the record. Step 4 is a code change with a test, and it must land before Task 5, which reads `cfg.required_checks`. An executor without GitHub access does Step 4 first and leaves the rest to the maintainer.

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `agents/scheduler.yaml` (App ids)
- Create: `~/.config/panelator/scheduler-app.pem` (outside the repo, mode 0600)

- [ ] **Step 1: Create the GitHub App** (spec section 12)

On github.com: Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: `panelator-pipeline` (the bot login becomes `panelator-pipeline[bot]`; if the name is taken, pick another and set `app.bot_login` in `agents/scheduler.yaml` to `<name>[bot]`).
- Homepage URL: the repository URL. Webhook: untick "Active" (the scheduler polls; no public endpoint).
- Repository permissions: Issues: Read and write. Pull requests: Read and write. Contents: Read and write. Checks: Read-only. Actions: Read-only. Metadata: Read-only. Repository security advisories: Read and write (for spec 004).
- Where can this app be installed: Only on this account.
- Create. Note the **App ID** on the app's General page.
- Generate a private key (General → Private keys → Generate). Save it:

```bash
mkdir -p ~/.config/panelator
mv ~/Downloads/panelator-pipeline.*.private-key.pem ~/.config/panelator/scheduler-app.pem
chmod 600 ~/.config/panelator/scheduler-app.pem
```

- Install the app: Install App → adam26davidson → Only select repositories → panelator. The installation id is the number at the end of the resulting URL `https://github.com/settings/installations/<id>`.

- [ ] **Step 2: Put the ids in the config**

Edit `agents/scheduler.yaml`: `app.id`, `app.installation_id`, `app.bot_login`. Commit.

- [ ] **Step 3: Create the labels**

```bash
R=adam26davidson/panelator
for l in validated in-progress needs-spec needs-design needs-clarification needs-human security-review blocked priority \
         class:product class:bug class:tooling class:dependency; do
  gh label create "$l" -R $R --force --color "$(printf '%06x' $((RANDOM*RANDOM % 16777216)))" >/dev/null && echo "label $l"
done
```

- [ ] **Step 4: Add the CI workflow the verify stage waits on** (AC-14 needs at least one check; the repository has none today. This file is outside spec 001's section 15 list and was added by this plan as a prerequisite.)

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm -F @panelator/scheduler typecheck
```

Commit. Add `required_checks: [test]` to `agents/scheduler.yaml` and the matching field to `Config` (`required_checks: string[]`, default `[]` meaning "every check run on the head SHA"), plus a line in `loadConfig`:

```ts
    required_checks: Array.isArray(raw.required_checks) ? (raw.required_checks as string[]) : [],
```

and the `config.test.ts` assertion `expect(c.required_checks).toEqual(["test"])`.

- [ ] **Step 5: Verify the App can authenticate** (after Task 2 lands):

```bash
node tools/scheduler/bin/scheduler.ts --check-auth
```

Expected: prints the bot login and token expiry. Done once; the output goes into the dev-log of Task 10.

---

### Task 2: App auth and token refresh

**Files:**
- Create: `tools/scheduler/src/github/auth.ts`
- Test: `tools/scheduler/test/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AppClient {
    octokit: Octokit;                                   // installation-authenticated
    installationToken(): Promise<{ token: string; expires_at: string }>;
    refreshTokenFile(paths: StatePaths): Promise<TokenFile>;
    startTokenRefresh(paths: StatePaths, intervalMs?: number): () => void;  // default 50 min; returns stop()
    botLogin(): Promise<string>;                        // "<slug>[bot]" from GET /app
  }
  function createAppClient(cfg: Config["app"], privateKey: string, fetchFn?: typeof fetch): AppClient
  ```
  Implementation (verified against octokit 5 on 2026-10-12):
  ```ts
  const app = new App({ appId: cfg.id, privateKey, Octokit: Octokit.defaults({ request: { fetch: fetchFn } }) });
  const auth = (await app.octokit.auth({ type: "installation", installationId: cfg.installation_id })) as { token: string; expiresAt: string };
  const octokit = await app.getInstallationOctokit(cfg.installation_id);
  ```

- [ ] **Step 1: Write the mock GitHub helper and the failing test**

`tools/scheduler/test/helpers/mock-github.ts`:

```ts
export interface Call { method: string; url: string; body: unknown }
export type Route = { method: string; path: RegExp; reply: (m: RegExpExecArray, body: unknown, url: URL) => { status?: number; body: unknown; headers?: Record<string, string> } };

/** A fetch that answers from a route table and records every call. Unmatched routes return 404 with the url. */
export function mockGitHub(routes: Route[]): { fetch: typeof fetch; calls: Call[]; routes: Route[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: url.pathname + url.search, body });
    for (const r of routes) {
      const m = r.path.exec(url.pathname);
      if (m && r.method === method) {
        const res = r.reply(m, body, url);
        return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json", ...(res.headers ?? {}) } });
      }
    }
    return new Response(JSON.stringify({ message: `mock: no route for ${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, routes };
}

export const tokenRoute: Route = {
  method: "POST", path: /^\/app\/installations\/(\d+)\/access_tokens$/,
  reply: () => ({ status: 201, body: { token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "selected" } }),
};
export const appRoute: Route = { method: "GET", path: /^\/app$/, reply: () => ({ body: { id: 1, slug: "panelator-pipeline", name: "panelator-pipeline" } }) };

export function pageLink(url: URL, page: number, last: number): Record<string, string> {
  if (page >= last) return {};
  const next = new URL(url);
  next.searchParams.set("page", String(page + 1));
  return { link: `<${next}>; rel="next"` };
}
```

`tools/scheduler/test/auth.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAppClient } from "../src/github/auth.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { readToken } from "../src/state/token.ts";
import { appRoute, mockGitHub, tokenRoute } from "./helpers/mock-github.ts";

export const testKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
const app = { id: 123, installation_id: 456, private_key_path: "/x", bot_login: "panelator-pipeline[bot]" };

describe("createAppClient", () => {
  it("mints an installation token with a JWT and reports the bot login", async () => {
    const gh = mockGitHub([tokenRoute, appRoute]);
    const c = createAppClient(app, testKey, gh.fetch);
    const t = await c.installationToken();
    expect(t).toEqual({ token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z" });
    expect(gh.calls[0]).toMatchObject({ method: "POST", url: "/app/installations/456/access_tokens" });
    expect(await c.botLogin()).toBe("panelator-pipeline[bot]");
  });
  it("writes token.json and refreshes on the interval (review focus 5)", async () => {
    vi.useFakeTimers();
    try {
      const gh = mockGitHub([tokenRoute, appRoute]);
      const c = createAppClient(app, testKey, gh.fetch);
      const p = statePaths(mkdtempSync(join(tmpdir(), "auth-")));
      await ensureStateDirs(p);
      await c.refreshTokenFile(p);
      expect((await readToken(p))?.token).toBe("ghs_mock");
      const before = gh.calls.filter((x) => x.url.endsWith("/access_tokens")).length;
      const stop = c.startTokenRefresh(p, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      stop();
      const after = gh.calls.filter((x) => x.url.endsWith("/access_tokens")).length;
      expect(after - before).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/auth.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/github/auth.ts`:

```ts
import { App, Octokit } from "octokit";
import type { Config } from "../config.ts";
import type { StatePaths } from "../state/paths.ts";
import { writeToken, type TokenFile } from "../state/token.ts";

export interface AppClient {
  octokit: Octokit;
  installationToken(): Promise<TokenFile>;
  refreshTokenFile(paths: StatePaths): Promise<TokenFile>;
  startTokenRefresh(paths: StatePaths, intervalMs?: number): () => void;
  botLogin(): Promise<string>;
}

export const TOKEN_REFRESH_MS = 50 * 60_000;

export function createAppClient(cfg: Config["app"], privateKey: string, fetchFn: typeof fetch = fetch): AppClient {
  const app = new App({ appId: cfg.id, privateKey, Octokit: Octokit.defaults({ request: { fetch: fetchFn } }) });
  let installation: Octokit | null = null;

  const client: AppClient = {
    get octokit() {
      if (!installation) throw new Error("call installationToken() before using the client");
      return installation;
    },
    async installationToken() {
      // Installation-authenticated client for all repository calls; octokit renews its own token internally.
      installation ??= await app.getInstallationOctokit(cfg.installation_id);
      // `refresh: true` bypasses octokit's token cache so every call here mints a fresh one for token.json.
      const a = (await app.octokit.auth({ type: "installation", installationId: cfg.installation_id, refresh: true })) as { token: string; expiresAt: string };
      return { token: a.token, expires_at: a.expiresAt };
    },
    async refreshTokenFile(paths) {
      const t = await client.installationToken();
      await writeToken(paths, t);
      return t;
    },
    startTokenRefresh(paths, intervalMs = TOKEN_REFRESH_MS) {
      const timer = setInterval(() => {
        client.refreshTokenFile(paths).catch((e) => console.error(`token refresh failed: ${(e as Error).message}`));
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    async botLogin() {
      const { data } = await app.octokit.request("GET /app");
      return `${(data as { slug: string }).slug}[bot]`;
    },
  };
  return client;
}
```

Verified on 2026-10-12 against octokit 5.0.5 with an injected fetch: `app.octokit.auth({ type: "installation", installationId })` posts a JWT to `/app/installations/{id}/access_tokens`, `app.getInstallationOctokit` paginates and runs GraphQL with the installation token, and `refresh?: boolean` is a documented option of the installation auth.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tools/scheduler/test/auth.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Add `--check-auth` to the entry point later (Task 8) and commit**

```bash
git add tools/scheduler/src/github/auth.ts tools/scheduler/test/auth.test.ts tools/scheduler/test/helpers/mock-github.ts
git commit -m "scheduler: GitHub App auth with installation token refresh every 50 minutes (spec section 12)"
```

---

### Task 3: GitHub client

**Files:**
- Create: `tools/scheduler/src/github/types.ts`, `tools/scheduler/src/github/client.ts`
- Test: `tools/scheduler/test/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PullRequestInfo { number: number; head_sha: string; url: string; mergeable: boolean | null; mergeable_state: string; merged: boolean; state: "open" | "closed" }
  interface CheckSummary { status: "green" | "failed" | "pending"; runs: { name: string; id: number; status: string; conclusion: string | null }[]; failed: { name: string; id: number }[] }
  class GitHubClient {
    constructor(octokit: Octokit, repo: string)   // "owner/name"
    listOpenIssues(): Promise<IssueData[]>         // REST paginate (PRs filtered out) + GraphQL totalCount assertion; timeline label events per issue
    labelEvents(issue: number): Promise<LabelEvent[]>
    addLabels(issue: number, labels: string[]): Promise<void>
    removeLabel(issue: number, label: string): Promise<void>   // 404 is not an error
    comment(issue: number, body: string): Promise<void>
    issueLabels(issue: number): Promise<string[]>
    issueActivityAt(issue: number): Promise<string>           // updated_at
    pullRequest(n: number): Promise<PullRequestInfo>
    checks(sha: string, required: string[]): Promise<CheckSummary>
    jobLogExcerpt(jobId: number, lines = 200): Promise<string>
    mergePullRequest(n: number, sha: string): Promise<{ merged: boolean; message: string }>  // squash, with sha guard
  }
  ```
  `listOpenIssues` throws `Error("issue list incomplete: got N, server reports M")` when counts differ (review focus 1).

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/client.test.ts`:

```ts
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";

const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
function issue(n: number, labels: string[] = ["validated"], extra: Record<string, unknown> = {}) {
  return { number: n, title: `i${n}`, body: `Spec: specs/0${n}0-x/spec.md`, user: BOT, labels: labels.map((name) => ({ name })), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...extra };
}
const timeline = (n: number): Route => ({
  method: "GET", path: new RegExp(`^/repos/o/r/issues/${n}/timeline$`),
  reply: () => ({ body: [
    { event: "labeled", actor: { login: "adam26davidson" }, label: { name: "validated" }, created_at: "2026-10-01T01:00:00Z" },
    { event: "commented", actor: { login: "x" }, created_at: "2026-10-01T02:00:00Z" },
    { event: "unlabeled", actor: { login: "adam26davidson" }, label: { name: "validated" }, created_at: "2026-10-01T03:00:00Z" },
    { event: "labeled", actor: { login: "panelator-pipeline[bot]" }, label: { name: "validated" }, created_at: "2026-10-01T04:00:00Z" },
  ] }),
});
function client(routes: Route[]) {
  const gh = mockGitHub(routes);
  const octokit = new Octokit({ auth: "ghs_mock", request: { fetch: gh.fetch } });
  return { c: new GitHubClient(octokit, "o/r"), gh };
}

describe("listOpenIssues (process-spec 6.4)", () => {
  const issuesRoute = (pages: unknown[][]): Route => ({
    method: "GET", path: /^\/repos\/o\/r\/issues$/,
    reply: (_m, _b, url) => { const page = Number(url.searchParams.get("page") ?? "1"); return { body: pages[page - 1] ?? [], headers: pageLink(url, page, pages.length) }; },
  });
  const total = (n: number): Route => ({ method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: n } } } } }) });
  it("paginates fully, drops pull requests, and attaches label events", async () => {
    const { c, gh } = client([issuesRoute([[issue(1), { ...issue(2), pull_request: { url: "x" } }], [issue(3)]]), total(2), timeline(1), timeline(3)]);
    const list = await c.listOpenIssues();
    expect(list.map((i) => i.number)).toEqual([1, 3]);
    expect(list[0]).toMatchObject({ author: "panelator-pipeline[bot]", labels: ["validated"], createdAt: "2026-10-01T00:00:00Z" });
    expect(list[0].labelEvents).toEqual([
      { label: "validated", actor: "adam26davidson", action: "labeled", at: "2026-10-01T01:00:00Z" },
      { label: "validated", actor: "adam26davidson", action: "unlabeled", at: "2026-10-01T03:00:00Z" },
      { label: "validated", actor: "panelator-pipeline[bot]", action: "labeled", at: "2026-10-01T04:00:00Z" },
    ]);
    expect(gh.calls.filter((x) => x.url.startsWith("/repos/o/r/issues?"))).toHaveLength(2);
  });
  it("throws when the count disagrees with the server total (review focus 1)", async () => {
    const { c } = client([issuesRoute([[issue(1)]]), total(5), timeline(1)]);
    await expect(c.listOpenIssues()).rejects.toThrow(/incomplete: got 1, server reports 5/);
  });
});

describe("labels, comments, activity", () => {
  it("adds and removes labels, tolerating a 404 on remove, and comments", async () => {
    const { c, gh } = client([
      { method: "POST", path: /^\/repos\/o\/r\/issues\/4\/labels$/, reply: () => ({ body: [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/issues\/4\/labels\/in-progress$/, reply: () => ({ status: 404, body: { message: "Label does not exist" } }) },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/4\/comments$/, reply: () => ({ status: 201, body: { id: 1 } }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/4$/, reply: () => ({ body: issue(4, ["validated", "in-progress"]) }) },
    ]);
    await c.addLabels(4, ["needs-spec"]);
    await c.removeLabel(4, "in-progress");
    await c.comment(4, "hello");
    expect(await c.issueLabels(4)).toEqual(["validated", "in-progress"]);
    expect(await c.issueActivityAt(4)).toBe("2026-10-02T00:00:00Z");
    expect(gh.calls.find((x) => x.method === "POST" && x.url.endsWith("/labels"))?.body).toEqual({ labels: ["needs-spec"] });
    expect(gh.calls.find((x) => x.url.endsWith("/comments"))?.body).toEqual({ body: "hello" });
  });
});

describe("pull requests, checks, merge (AC-14)", () => {
  const pr = { number: 9, head: { sha: "a".repeat(40) }, html_url: "https://github.com/o/r/pull/9", mergeable: true, mergeable_state: "clean", merged: false, state: "open" };
  const runs = (list: unknown[]): Route => ({ method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: list.length, check_runs: list } }) });
  it("summarises check runs as green, failed or pending, honouring the required list", async () => {
    const { c } = client([runs([
      { id: 1, name: "test", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "failure" },
      { id: 3, name: "deploy", status: "in_progress", conclusion: null },
    ])]);
    expect((await c.checks("a".repeat(40), ["test"])).status).toBe("green");
    expect((await c.checks("a".repeat(40), ["test", "lint"]))).toMatchObject({ status: "failed", failed: [{ name: "lint", id: 2 }] });
    expect((await c.checks("a".repeat(40), [])).status).toBe("failed");
    expect((await c.checks("a".repeat(40), ["deploy"])).status).toBe("pending");
  });
  it("treats a required check that has not been reported yet as pending", async () => {
    const { c } = client([runs([])]);
    expect((await c.checks("a".repeat(40), ["test"])).status).toBe("pending");
  });
  it("reads a PR and squash-merges with the sha guard", async () => {
    const { c, gh } = client([
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: pr }) },
      { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "Pull Request successfully merged", sha: "m" } }) },
    ]);
    expect(await c.pullRequest(9)).toEqual({ number: 9, head_sha: "a".repeat(40), url: pr.html_url, mergeable: true, mergeable_state: "clean", merged: false, state: "open" });
    expect(await c.mergePullRequest(9, "a".repeat(40))).toEqual({ merged: true, message: "Pull Request successfully merged" });
    expect(gh.calls.find((x) => x.method === "PUT")?.body).toEqual({ merge_method: "squash", sha: "a".repeat(40) });
  });
  it("returns merged:false with the message on a 405", async () => {
    const { c } = client([{ method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ status: 405, body: { message: "Pull Request is not mergeable" } }) }]);
    expect(await c.mergePullRequest(9, "a".repeat(40))).toEqual({ merged: false, message: "Pull Request is not mergeable" });
  });
  it("fetches the tail of a job log", async () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const gh = mockGitHub([]);
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/actions/jobs/2/logs")) return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
      return gh.fetch(input, init);
    }) as typeof fetch;
    const c = new GitHubClient(new Octokit({ auth: "x", request: { fetch: fetchFn } }), "o/r");
    const excerpt = await c.jobLogExcerpt(2, 50);
    expect(excerpt.split("\n")).toHaveLength(50);
    expect(excerpt.endsWith("line 299")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/github/types.ts`:

```ts
export interface PullRequestInfo {
  number: number;
  head_sha: string;
  url: string;
  mergeable: boolean | null;
  mergeable_state: string;
  merged: boolean;
  state: "open" | "closed";
}

export interface CheckRun {
  name: string;
  id: number;
  status: string;
  conclusion: string | null;
}

export interface CheckSummary {
  status: "green" | "failed" | "pending";
  runs: CheckRun[];
  failed: { name: string; id: number }[];
}
```

`tools/scheduler/src/github/client.ts`:

```ts
import type { Octokit } from "octokit";
import type { IssueData, LabelEvent } from "../types.ts";
import type { CheckRun, CheckSummary, PullRequestInfo } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec => (typeof x === "object" && x !== null ? (x as Rec) : {});

export class GitHubClient {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(octokit: Octokit, repo: string) {
    this.octokit = octokit;
    [this.owner, this.repo] = repo.split("/") as [string, string];
  }

  private get base() {
    return { owner: this.owner, repo: this.repo };
  }

  /** Full pagination, PRs dropped, count asserted against the GraphQL total (process-spec 6.4). */
  async listOpenIssues(): Promise<IssueData[]> {
    const raw = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues", { ...this.base, state: "open", per_page: 100 })) as Rec[];
    const issues = raw.filter((i) => !i.pull_request);
    const g = (await this.octokit.graphql(
      `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(states:OPEN){totalCount}}}`,
      this.base,
    )) as { repository: { issues: { totalCount: number } } };
    const total = g.repository.issues.totalCount;
    if (issues.length !== total) throw new Error(`issue list incomplete: got ${issues.length}, server reports ${total}`);
    const out: IssueData[] = [];
    for (const i of issues) {
      out.push({
        number: Number(i.number),
        title: String(i.title ?? ""),
        author: String(rec(i.user).login ?? ""),
        body: String(i.body ?? ""),
        labels: ((i.labels as unknown[]) ?? []).map((l) => (typeof l === "string" ? l : String(rec(l).name))),
        labelEvents: await this.labelEvents(Number(i.number)),
        createdAt: String(i.created_at),
      });
    }
    return out;
  }

  async labelEvents(issue: number): Promise<LabelEvent[]> {
    const events = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", { ...this.base, issue_number: issue, per_page: 100 })) as Rec[];
    return events
      .filter((e) => e.event === "labeled" || e.event === "unlabeled")
      .map((e) => ({ label: String(rec(e.label).name), actor: String(rec(e.actor).login ?? ""), action: e.event as LabelEvent["action"], at: String(e.created_at) }));
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...this.base, issue_number: issue, labels });
  }

  async removeLabel(issue: number, label: string): Promise<void> {
    try {
      await this.octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...this.base, issue_number: issue, name: label });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...this.base, issue_number: issue, body });
  }

  async issueLabels(issue: number): Promise<string[]> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue });
    return (data.labels as unknown[]).map((l) => (typeof l === "string" ? l : String(rec(l).name)));
  }

  async issueActivityAt(issue: number): Promise<string> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue });
    return String(data.updated_at);
  }

  async pullRequest(n: number): Promise<PullRequestInfo> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...this.base, pull_number: n });
    return { number: data.number, head_sha: data.head.sha, url: data.html_url, mergeable: data.mergeable ?? null, mergeable_state: String(data.mergeable_state ?? ""), merged: Boolean(data.merged), state: data.state as "open" | "closed" };
  }

  /** `required` empty means every check run on the sha must succeed; a required name not yet reported is pending. */
  async checks(sha: string, required: string[]): Promise<CheckSummary> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...this.base, ref: sha, per_page: 100 });
    const runs: CheckRun[] = data.check_runs.map((r) => ({ name: r.name, id: r.id, status: r.status, conclusion: r.conclusion ?? null }));
    const considered = required.length ? runs.filter((r) => required.includes(r.name)) : runs;
    const missing = required.filter((n) => !runs.some((r) => r.name === n));
    const failed = considered.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => ({ name: r.name, id: r.id }));
    if (failed.length) return { status: "failed", runs, failed };
    if (missing.length || considered.some((r) => r.status !== "completed") || considered.length === 0) return { status: "pending", runs, failed };
    return { status: "green", runs, failed };
  }

  async jobLogExcerpt(jobId: number, lines = 200): Promise<string> {
    const res = await this.octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { ...this.base, job_id: jobId });
    const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
    return text.split("\n").filter((l) => l.length).slice(-lines).join("\n");
  }

  async mergePullRequest(n: number, sha: string): Promise<{ merged: boolean; message: string }> {
    try {
      const { data } = await this.octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { ...this.base, pull_number: n, merge_method: "squash", sha });
      return { merged: Boolean(data.merged), message: String(data.message ?? "") };
    } catch (e) {
      const err = e as { status?: number; message?: string; response?: { data?: { message?: string } } };
      if (err.status === 405 || err.status === 409 || err.status === 422) return { merged: false, message: err.response?.data?.message ?? err.message ?? `HTTP ${err.status}` };
      throw e;
    }
  }
}
```

Note on `checks` with `required: []` and zero runs: `pending`. The `required_checks` config from Task 1 names `test`, so a PR with no CI yet waits rather than merging unverified. The test "`required: []` → failed" uses the lint failure; keep it.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/client.test.ts`
Expected: 8 passed. If the job-log test fails because octokit follows the 302 to a non-JSON body, the mock returns the text directly; octokit passes it through as `data` when `content-type` is `text/plain`.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/github tools/scheduler/test/client.test.ts
git commit -m "scheduler: GitHub client with full pagination, completeness assertion, label timeline, checks and squash merge"
```

---

### Task 4: Shortlist fetch context and merges record

**Files:**
- Create: `tools/scheduler/src/shortlist/fetch.ts`, `tools/scheduler/src/state/merges.ts`
- Test: `tools/scheduler/test/fetch.test.ts`

**Interfaces:**
- Produces: `buildSelectContext(repoDir: string, cfg: Config, claimed: Set<number>, botLogin: string): SelectContext` whose `readSpec(path)` runs `git -C repoDir show origin/main:<path>` (null on failure) and `listDesign(specPath)` runs `git -C repoDir ls-tree --name-only origin/main:<dir>/design` (empty array on failure).
- Produces: `appendMerge(p: StatePaths, m: { issue: number; pr: number; cls: "feature" | "debt" | "none"; at: string }): Promise<void>` to `<root>/merges.jsonl`; `recentMerges(p, now: Date, days = 14): Promise<RecentMerges>`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/fetch.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.ts";
import { buildSelectContext } from "../src/shortlist/fetch.ts";
import { appendMerge, recentMerges } from "../src/state/merges.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

function git(cwd: string, ...a: string[]) {
  return execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

describe("buildSelectContext", () => {
  it("reads specs and design listings from origin/main, not the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "fetch-"));
    const origin = join(root, "o.git");
    git(root, "init", "--bare", "-q", "-b", "main", origin);
    const repo = join(root, "repo");
    git(root, "clone", "-q", origin, repo);
    mkdirSync(join(repo, "specs", "010-x", "design"), { recursive: true });
    writeFileSync(join(repo, "specs", "010-x", "spec.md"), "# committed\n");
    writeFileSync(join(repo, "specs", "010-x", "design", "a.png"), "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "spec");
    git(repo, "push", "-q", "origin", "main");
    writeFileSync(join(repo, "specs", "010-x", "spec.md"), "# dirty working tree\n");
    const ctx = buildSelectContext(repo, loadConfig(defaultConfigPath), new Set([3]), "panelator-pipeline[bot]");
    expect(ctx.readSpec("specs/010-x/spec.md")).toBe("# committed\n");
    expect(ctx.readSpec("specs/999-none/spec.md")).toBeNull();
    expect(ctx.listDesign("specs/010-x/spec.md")).toEqual(["a.png"]);
    expect(ctx.listDesign("specs/999-none/spec.md")).toEqual([]);
    expect(ctx.claimed.has(3)).toBe(true);
    expect(ctx.appBot).toBe("panelator-pipeline[bot]");
  });
});

describe("merges record", () => {
  it("counts recent merges by class", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "m-")));
    await ensureStateDirs(p);
    await appendMerge(p, { issue: 1, pr: 2, cls: "feature", at: "2026-10-10T00:00:00Z" });
    await appendMerge(p, { issue: 3, pr: 4, cls: "debt", at: "2026-10-11T00:00:00Z" });
    await appendMerge(p, { issue: 5, pr: 6, cls: "feature", at: "2026-01-01T00:00:00Z" });
    expect(await recentMerges(p, new Date("2026-10-12T00:00:00Z"))).toEqual({ feature: 1, debt: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/fetch.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/shortlist/fetch.ts`:

```ts
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import type { SelectContext } from "./select.ts";

function gitShow(repoDir: string, ref: string): string | null {
  try {
    return execFileSync("git", ["show", ref], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Specs and design artifacts are read from origin/main, never from the working tree (spec section 8, "on main"). */
export function buildSelectContext(repoDir: string, cfg: Config, claimed: Set<number>, botLogin: string): SelectContext {
  return {
    appBot: botLogin,
    maintainer: cfg.maintainer,
    labels: cfg.labels,
    claimed,
    readSpec: (path) => gitShow(repoDir, `origin/main:${path}`),
    listDesign: (specPath) => {
      try {
        const out = execFileSync("git", ["ls-tree", "--name-only", `origin/main:${dirname(specPath)}/design`], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
```

`tools/scheduler/src/state/merges.ts`:

```ts
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecentMerges } from "../shortlist/rank.ts";
import type { StatePaths } from "./paths.ts";

export interface MergeRecord {
  issue: number;
  pr: number;
  cls: "feature" | "debt" | "none";
  at: string;
}

const file = (p: StatePaths) => join(p.root, "merges.jsonl");

export async function appendMerge(p: StatePaths, m: MergeRecord): Promise<void> {
  await appendFile(file(p), JSON.stringify(m) + "\n");
}

export async function recentMerges(p: StatePaths, now: Date, days = 14): Promise<RecentMerges> {
  const cutoff = now.getTime() - days * 86_400_000;
  const out = { feature: 0, debt: 0 };
  const text = await readFile(file(p), "utf8").catch(() => "");
  for (const line of text.split("\n").filter(Boolean)) {
    const m = JSON.parse(line) as MergeRecord;
    if (new Date(m.at).getTime() < cutoff) continue;
    if (m.cls === "feature") out.feature++;
    else if (m.cls === "debt") out.debt++;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/fetch.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/shortlist/fetch.ts tools/scheduler/src/state/merges.ts tools/scheduler/test/fetch.test.ts
git commit -m "scheduler: shortlist context from origin/main and merge history for the 2:1 ratio"
```

---

### Task 5: Chain driver

**Files:**
- Create: `tools/scheduler/src/chain/driver.ts`
- Create: `tools/scheduler/test/helpers/repo-pair.ts` (extract from plan 2's `worktree.test.ts` `repoPair()`; update that test to import it)
- Test: `tools/scheduler/test/driver.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DriverDeps {
    cfg: Config; paths: StatePaths; gh: GitHubClient; notifier: Notifier;
    stages: Record<AgentStageName, StageDefinition>; agentsDir: string; repoDir: string; binDir: string;
    adapterFor: (harness: Harness) => Adapter;        // tests inject a scripted fake for every harness
    systemdScope: boolean; now: () => Date; log: (rec: Record<string, unknown>) => void;
    fetchOrigin: () => Promise<void>;                 // `git fetch origin main` on repoDir; injectable
  }
  type StepStatus = "continue" | "waiting" | "ended";
  async function step(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }>
  async function driveChain(deps: DriverDeps, claim: Claim, isStopping: () => boolean): Promise<Claim>   // loops step() until waiting or ended or stopping
  ```
  `step` decides the event from `claim.state.stage`:
  - `claimed`: `{type: "start"}`.
  - `waiting`: if `postponedUntil` is null or `<= now`: `{type: "start"}`, else return `waiting`.
  - agent stage (`plan`, `implement`, `review`, `fix`): `fetchOrigin()`, `rebaseOntoMain(worktree)`; on conflict → `{type:"rebase_conflict"}`; else build `StageInput` (issue title/body via `gh`, spec text via `git show origin/main:<path>`, plan, pr, ci, fix_input from `state.pendingFixInput`), pick profile (`def.profile === "from-issue"` → `state.plan.domain`, `security` when the previous `checks` event was sensitive, which the driver stores in `claim.state` by re-running `isSensitive(diffFilesAgainstBase(worktree))` right before review), run `runStage` with `touchClaim(run_id)` before and `run_id: null` after. Map outcome: `ok` → `stage_ok` with `scope` (implement/fix: `scopeGate(diffFiles, state.plan, spec, sensitiveGlobs)`), `security` flag (review); `failed`/`bounds`/`timeout` → `retryDecision`; `fallback` → run once more with the fallback model and harness, then map that outcome; `postpone` → `stage_failed` with `postpone: true` and `postponedUntil = now + 30 min`; else `stage_failed`.
  - `verify`: `gh.checks(pr.head_sha, cfg.required_checks)` → `{type:"checks", status, log (jobLogExcerpt of the first failed), sensitive}`.
  - `merge`: `gh.pullRequest(n)`; if `mergeable === false` → `merge_result not_mergeable` with `mergeable_state`; else `gh.mergePullRequest(n, head_sha)` → `merged` or `not_mergeable` with the message; on merged, `appendMerge` with the issue's class.
  - `done`, `released`, `needs-human`: return `ended`.
  Then `transition(state, event)`; apply actions: `label` → `gh.addLabels`/`gh.removeLabel`; `comment` → `gh.comment`; `notify` → `notifier.notify({issue, gate, label, text})`; `release` → if `savePatch`, `savePatch(paths, issue, await uncommittedPatch(worktree))`; `removeClaim`; on `done` → `removeWorktree`, `removeClaim`; `wait` → status `waiting` (store `postponedUntil` for `POSTPONE_WAIT_S`; for `PENDING_WAIT_S` the loop re-polls on the next tick); `run_stage`, `verify`, `merge` → status `continue`. Persist the claim after every step (`writeClaim`), with `last_activity_at = now`.

- [ ] **Step 1: Write the helpers and the failing tests**

`tools/scheduler/test/helpers/repo-pair.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A bare origin plus a checkout that stands in for the scheduler's repo, with one commit on main. */
export function repoPair(files: Record<string, string> = { "a.txt": "a\n" }) {
  const root = mkdtempSync(join(tmpdir(), "pair-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const repo = join(root, "repo");
  git(root, "clone", "-q", origin, repo);
  for (const [p, c] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", join(repo, p, "..")]);
    writeFileSync(join(repo, p), c);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  return { root, origin, repo, worktrees: join(root, "worktrees") };
}
```

`tools/scheduler/test/driver.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters/types.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { driveChain, step, type DriverDeps } from "../src/chain/driver.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { ensureWorktree } from "../src/runner/worktree.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, writeClaim, type Claim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, type Route } from "./helpers/mock-github.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl");
const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const SHA = "a".repeat(40);

/** One fake adapter that answers per stage from a script of results. */
function scriptedAdapter(results: Record<string, unknown[]>): Adapter & { ran: string[] } {
  const ran: string[] = [];
  return {
    harness: "fake", ran,
    buildCommand(run) {
      ran.push(`${run.stage}:${run.model}`);
      const r = results[run.stage]?.shift();
      const argv = [process.execPath, script, events, run.resultPath, r === undefined ? "1" : "0", "0"];
      if (r !== undefined) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, timedOut) => timedOut ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null }
      : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : { outcome: "failed", reason: `exit ${exit}`, apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

function ghRoutes(over: { checks?: unknown[]; mergeable?: boolean } = {}): Route[] {
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: { number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", labels: [{ name: "validated" }, { name: "in-progress" }, { name: "class:product" }], updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: () => ({ status: 201, body: {} }) },
    { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, head: { sha: SHA }, html_url: "u", mergeable: over.mergeable ?? true, mergeable_state: "clean", merged: false, state: "open" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: over.checks ?? [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
  ];
}

async function setup(results: Record<string, unknown[]>, routes = ghRoutes()) {
  const pair = repoPair({ "a.txt": "a\n", "specs/010-thing/spec.md": spec });
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const gh = mockGitHub(routes);
  const notifications: Notification[] = [];
  const adapter = scriptedAdapter(results);
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root };
  const deps: DriverDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: () => {}, fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
  };
  const wt = await ensureWorktree(pair.repo, pair.worktrees, 7);
  const claim: Claim = { issue: 7, slot: 0, state: initialChainState(7), worktree: wt.path, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null };
  await writeClaim(paths, claim);
  return { deps, claim, gh, notifications, adapter, pair, paths };
}

const plan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
const impl = { pr_number: 9, head_sha: SHA, tasks_done: ["T1"] };
const approve = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };

describe("driveChain", () => {
  it("runs a full chain to done, applying labels and recording a merge (AC-1, AC-3, AC-14)", async () => {
    const { deps, claim, gh, adapter, paths } = await setup({ plan: [plan], implement: [impl], review: [approve] });
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("done");
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5", "review:claude-fable-5-1"]);
    expect(gh.calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "squash", sha: SHA });
    expect(gh.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toContain("/repos/o/r/issues/7/labels/in-progress");
    expect(await listClaims(paths)).toEqual([]);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"cls":"feature"');
  }, 60_000);

  it("posts questions, labels needs-clarification and releases on spec_gap (AC-9)", async () => {
    const { deps, claim, gh, notifications, paths } = await setup({ plan: [{ verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which port?"] }] });
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("released");
    expect(gh.calls.filter((c) => c.url.endsWith("/comments"))).toHaveLength(1);
    expect(gh.calls.find((c) => c.url.endsWith("/comments"))?.body).toMatchObject({ body: expect.stringContaining("Which port?") });
    expect(gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/labels"))?.body).toEqual({ labels: ["needs-clarification"] });
    expect(notifications).toEqual([expect.objectContaining({ issue: 7, gate: "ready", label: "needs-clarification" })]);
    expect(await listClaims(paths)).toEqual([]);
  }, 60_000);

  it("waits on pending checks and starts fix with the failing log (AC-14)", async () => {
    const { deps, claim } = await setup({ plan: [plan], implement: [impl] }, ghRoutes({ checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] }));
    const r = await driveChain(deps, claim, () => false);
    expect(r.state.stage).toBe("verify");
    deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: mockGitHub(ghRoutes({ checks: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }] })).fetch } }), "o/r");
    const s = await step(deps, r);
    expect(s.claim.state.stage).toBe("fix");
    expect(s.claim.state.pendingFixInput).toMatch(/check failed/);
  }, 60_000);

  it("retries a failed plan once, then needs-human with a notification", async () => {
    const { deps, claim, notifications, adapter } = await setup({ plan: [] });
    const final = await driveChain(deps, claim, () => false);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(final.state.stage).toBe("needs-human");
    expect(notifications[0]).toMatchObject({ gate: "plan", label: "needs-human" });
  }, 60_000);

  it("stops between stages when asked to stop (AC-31)", async () => {
    const { deps, claim } = await setup({ plan: [plan], implement: [impl], review: [approve] });
    let calls = 0;
    const r = await driveChain(deps, claim, () => ++calls > 1);
    expect(r.state.stage).toBe("implement");
  }, 60_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/driver.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/chain/driver.ts`:

```ts
import { adapterFor as defaultAdapterFor } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { isSensitive, scopeGate } from "../gates/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { Notifier } from "../notify/types.ts";
import { readSensitiveGlobs, resolveProfile } from "../profiles/resolve.ts";
import { retryDecision } from "../runner/retry.ts";
import { runStage, type StageOutcome } from "../runner/run.ts";
import { diffFilesAgainstBase, rebaseOntoMain, removeWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { StageInput } from "../stages/prompt.ts";
import { removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { appendMerge } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import type { StatePaths } from "../state/paths.ts";
import { classOf } from "../shortlist/rank.ts";
import type { AgentStageName, Harness, Profile, StageDefinition } from "../types.ts";
import { POSTPONE_WAIT_S, transition } from "./machine.ts";
import type { Action, ChainEvent, ChainState } from "./types.ts";
import { execFileSync } from "node:child_process";

export interface DriverDeps {
  cfg: Config;
  paths: StatePaths;
  gh: GitHubClient;
  notifier: Notifier;
  stages: Record<AgentStageName, StageDefinition>;
  agentsDir: string;
  repoDir: string;
  binDir: string;
  adapterFor: (harness: Harness) => Adapter;
  systemdScope: boolean;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  fetchOrigin: () => Promise<void>;
}

export type StepStatus = "continue" | "waiting" | "ended";
const AGENT_STAGES: AgentStageName[] = ["plan", "implement", "review", "fix"];
const ENDED: ChainState["stage"][] = ["done", "released", "needs-human"];

export { defaultAdapterFor };

function specOnMain(repoDir: string, path: string | null): string {
  if (!path) return "";
  try {
    return execFileSync("git", ["show", `origin/main:${path}`], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function buildInput(deps: DriverDeps, claim: Claim, issueTitle: string, issueBody: string, specText: string, ci: string | undefined): Promise<StageInput> {
  const s = claim.state;
  const pr = s.pr ? { number: s.pr.number, head_sha: s.pr.head_sha, url: `https://github.com/${deps.cfg.repo}/pull/${s.pr.number}` } : undefined;
  return {
    issue: { number: claim.issue, title: issueTitle, body: issueBody },
    spec: specText, plan: s.plan ?? undefined, pr, ci, fix_input: s.pendingFixInput ?? undefined,
    result_path: "", profile_instructions: "",
  };
}

function pickProfile(deps: DriverDeps, def: StageDefinition, state: ChainState, security: boolean): Profile | null {
  if (security && def.name === "review") return resolveProfile(deps.agentsDir, "security");
  if (def.profile === "none") return null;
  const name = def.profile === "from-issue" ? state.plan?.domain ?? "backend" : def.profile;
  try {
    return resolveProfile(deps.agentsDir, name);
  } catch {
    return resolveProfile(deps.agentsDir, "backend");
  }
}

async function runAgentStage(deps: DriverDeps, claim: Claim, stage: AgentStageName): Promise<ChainEvent> {
  const state = claim.state;
  const def = deps.stages[stage];
  const sensitiveGlobs = readSensitiveGlobs(deps.agentsDir);

  await deps.fetchOrigin();
  const rebase = await rebaseOntoMain(claim.worktree);
  if (!rebase.ok) return { type: "rebase_conflict", detail: rebase.conflict };

  const { data: issue } = await deps.gh.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: deps.gh.owner, repo: deps.gh.repo, issue_number: claim.issue });
  const specPath = specPathFromIssueBody(String(issue.body ?? ""));
  const specText = specOnMain(deps.repoDir, specPath);
  const diffBefore = await diffFilesAgainstBase(claim.worktree);
  const security = stage === "review" && isSensitive(diffBefore, sensitiveGlobs).length > 0;
  const profile = pickProfile(deps, def, state, security);
  const input = await buildInput(deps, claim, String(issue.title ?? ""), String(issue.body ?? ""), specText, undefined);

  const attempt = state.attempt;
  const exec = async (model?: string, harness?: Harness): Promise<StageOutcome> => {
    const h = harness ?? def.harness;
    claim.run_id = `${claim.issue}-${stage}-${attempt}`;
    await writeClaim(deps.paths, { ...claim, last_activity_at: deps.now().toISOString() });
    try {
      return await runStage(
        { paths: deps.paths, adapter: deps.adapterFor(h), systemdScope: deps.systemdScope, binDir: deps.binDir, now: deps.now },
        { def, input, issue: claim.issue, attempt, worktree: claim.worktree, profile, model, harness },
      );
    } finally {
      claim.run_id = null;
    }
  };

  let out = await exec();
  deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId });
  if (out.outcome !== "ok") {
    const retry = retryDecision(def, out.judgement, out.usage.cost_usd ?? 0, deps.cfg.retry_cost_limit_usd);
    if (retry.kind === "postpone") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome, postpone: true };
    if (retry.kind === "fallback") {
      out = await exec(retry.model, retry.harness);
      deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId, fallback: retry.model });
    }
  }
  if (out.outcome !== "ok") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome };

  const result = out.result as never;
  if (stage === "plan") return { type: "stage_ok", stage: "plan", result };
  if (stage === "review") return { type: "stage_ok", stage: "review", result, security };
  const diff = await diffFilesAgainstBase(claim.worktree);
  const scope = state.plan ? scopeGate(diff, state.plan, parseSpec(specText), sensitiveGlobs) : { ok: true as const };
  return stage === "implement" ? { type: "stage_ok", stage: "implement", result, scope } : { type: "stage_ok", stage: "fix", result, scope };
}

async function verifyEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`verify without a PR (issue ${claim.issue})`);
  const summary = await deps.gh.checks(pr.head_sha, deps.cfg.required_checks);
  const sensitive = isSensitive(await diffFilesAgainstBase(claim.worktree), readSensitiveGlobs(deps.agentsDir)).length > 0;
  if (summary.status === "failed") {
    const first = summary.failed[0];
    const log = await deps.gh.jobLogExcerpt(first.id).catch(() => `(no log for ${first.name})`);
    return { type: "checks", status: "failed", log: `${first.name}\n${log}`, sensitive };
  }
  return { type: "checks", status: summary.status, sensitive };
}

async function mergeEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`merge without a PR (issue ${claim.issue})`);
  const info = await deps.gh.pullRequest(pr.number);
  if (info.mergeable === false) return { type: "merge_result", status: "not_mergeable", detail: info.mergeable_state };
  const r = await deps.gh.mergePullRequest(pr.number, info.head_sha);
  if (!r.merged) return { type: "merge_result", status: "not_mergeable", detail: r.message };
  const labels = await deps.gh.issueLabels(claim.issue);
  const cls = classOf({ number: claim.issue, title: "", author: "", body: "", labels, labelEvents: [], createdAt: "" }, deps.cfg.labels);
  await appendMerge(deps.paths, { issue: claim.issue, pr: pr.number, cls, at: deps.now().toISOString() });
  return { type: "merge_result", status: "merged" };
}

export async function applyActions(deps: DriverDeps, claim: Claim, actions: Action[]): Promise<StepStatus> {
  let status: StepStatus = "continue";
  for (const a of actions) {
    switch (a.type) {
      case "label":
        await deps.gh.addLabels(claim.issue, a.add);
        for (const l of a.remove) await deps.gh.removeLabel(claim.issue, l);
        break;
      case "comment":
        await deps.gh.comment(claim.issue, a.text);
        break;
      case "notify":
        await deps.notifier.notify({ issue: claim.issue, gate: a.gate, label: a.label, text: a.text });
        break;
      case "release":
        if (a.savePatch) await savePatch(deps.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""));
        await removeClaim(deps.paths, claim.issue);
        status = "ended";
        break;
      case "done":
        await removeWorktree(deps.repoDir, claim.worktree).catch((e) => deps.log({ kind: "error", issue: claim.issue, error: `worktree remove: ${(e as Error).message}` }));
        await removeClaim(deps.paths, claim.issue);
        status = "ended";
        break;
      case "wait":
        claim.state.postponedUntil = a.seconds >= POSTPONE_WAIT_S ? new Date(deps.now().getTime() + a.seconds * 1000).toISOString() : null;
        status = "waiting";
        break;
      default:
        break;
    }
  }
  return status;
}

export async function step(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }> {
  const stage = claim.state.stage;
  if (ENDED.includes(stage)) return { claim, status: "ended" };
  let event: ChainEvent;
  if (stage === "claimed") event = { type: "start" };
  else if (stage === "waiting") {
    const until = claim.state.postponedUntil;
    if (until && new Date(until) > deps.now()) return { claim, status: "waiting" };
    event = { type: "start" };
  } else if (AGENT_STAGES.includes(stage as AgentStageName)) event = await runAgentStage(deps, claim, stage as AgentStageName);
  else if (stage === "verify") event = await verifyEvent(deps, claim);
  else if (stage === "merge") event = await mergeEvent(deps, claim);
  else throw new Error(`unhandled stage ${stage}`);

  const { state, actions } = transition(claim.state, event);
  claim = { ...claim, state, last_activity_at: deps.now().toISOString() };
  const status = await applyActions(deps, claim, actions);
  deps.log({ kind: "transition", issue: claim.issue, event: event.type, stage: state.stage, status });
  if (status !== "ended") await writeClaim(deps.paths, claim);
  return { claim, status };
}

export async function driveChain(deps: DriverDeps, claim: Claim, isStopping: () => boolean): Promise<Claim> {
  let current = claim;
  while (!isStopping()) {
    const r = await step(deps, current);
    current = r.claim;
    if (r.status !== "continue") break;
  }
  return current;
}
```

Note: `exec` sets a provisional `run_id` so the liveness gate sees a run in flight (AC-15) even before the runner has assigned the real id; the runner's own id lands in the usage record.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tools/scheduler/test/driver.test.ts tools/scheduler/test/worktree.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 5 + 5 passed; tsc clean. Each chain spawns three Node processes, so the file takes a few seconds.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/chain/driver.ts tools/scheduler/test/driver.test.ts tools/scheduler/test/helpers/repo-pair.ts tools/scheduler/test/worktree.test.ts
git commit -m "scheduler: chain driver executing state-machine actions against GitHub and the runner"
```

---

### Task 6: Service helpers: git freshness, sleep inhibitor, service log

**Files:**
- Create: `tools/scheduler/src/service/git.ts`, `tools/scheduler/src/service/inhibit.ts`, `tools/scheduler/src/service/log.ts`
- Test: `tools/scheduler/test/service-helpers.test.ts`

**Interfaces:**
- Produces: `fetchOrigin(repoDir): Promise<void>`; `fastForwardMain(repoDir): Promise<{ moved: boolean; changedPaths: string[] }>` (`git merge --ff-only origin/main` on the checkout, which must be on `main`; `changedPaths` from `git diff --name-only <before> <after>`); `schedulerChanged(paths: string[]): boolean` (any path under `tools/scheduler/`).
- Produces: `class SleepInhibitor { constructor(opts: { enabled: boolean; bin?: string; spawn?: typeof child_process.spawn }); acquire(): void; release(): void; get held(): boolean }` running `systemd-inhibit --what=sleep:idle --who=panelator-scheduler --why="stage in flight" --mode=block sleep infinity` (AC-30); `acquire` is idempotent, `release` kills the child.
- Produces: `class ServiceLog { constructor(path: string); write(rec: Record<string, unknown>): void; tick(info): void; stopped(reason): void }` writing JSONL with `at` and `kind`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/service-helpers.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fastForwardMain, fetchOrigin, schedulerChanged } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { ServiceLog } from "../src/service/log.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

describe("fastForwardMain (AC-17)", () => {
  it("fast-forwards and reports changed paths", async () => {
    const pair = repoPair();
    const other = join(pair.root, "other");
    git(pair.root, "clone", "-q", pair.origin, other);
    mkdirSync(join(other, "tools", "scheduler", "src"), { recursive: true });
    writeFileSync(join(other, "tools", "scheduler", "src", "x.ts"), "export {};\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "change");
    git(other, "push", "-q", "origin", "main");
    expect(await fastForwardMain(pair.repo)).toEqual({ moved: false, changedPaths: [] });
    await fetchOrigin(pair.repo);
    const r = await fastForwardMain(pair.repo);
    expect(r).toEqual({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    expect(schedulerChanged(r.changedPaths)).toBe(true);
    expect(schedulerChanged(["web/a.ts"])).toBe(false);
  });
});

describe("SleepInhibitor (AC-30)", () => {
  it("spawns one inhibitor while held and kills it on release", () => {
    const spawned: string[][] = [];
    let killed = 0;
    const fakeSpawn = ((cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return { kill: () => { killed++; return true; }, unref() {}, on() {} }; }) as never;
    const i = new SleepInhibitor({ enabled: true, spawn: fakeSpawn });
    i.acquire();
    i.acquire();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(["systemd-inhibit", "--what=sleep:idle", "--who=panelator-scheduler", "--why=stage in flight", "--mode=block", "sleep", "infinity"]);
    expect(i.held).toBe(true);
    i.release();
    expect(killed).toBe(1);
    expect(i.held).toBe(false);
  });
  it("does nothing when disabled", () => {
    const i = new SleepInhibitor({ enabled: false, spawn: (() => { throw new Error("no"); }) as never });
    i.acquire();
    expect(i.held).toBe(false);
  });
});

describe("ServiceLog (AC-31)", () => {
  it("writes tick and stopped trailers as JSONL", () => {
    const p = join(mkdtempSync(join(tmpdir(), "log-")), "service.jsonl");
    const log = new ServiceLog(p);
    log.tick({ claimed: [7], eligible: 2 });
    log.stopped("SIGTERM");
    const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "tick", claimed: [7], eligible: 2, at: expect.any(String) });
    expect(lines[1]).toMatchObject({ kind: "stopped", reason: "SIGTERM" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/service-helpers.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/service/git.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, encoding: "utf8" });

export async function fetchOrigin(repoDir: string): Promise<void> {
  await git(repoDir, "fetch", "-q", "origin", "main");
}

/** `--ff-only` so the service never merges or rebases its own checkout (S16). */
export async function fastForwardMain(repoDir: string): Promise<{ moved: boolean; changedPaths: string[] }> {
  const before = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  await git(repoDir, "merge", "-q", "--ff-only", "origin/main");
  const after = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  if (before === after) return { moved: false, changedPaths: [] };
  const changedPaths = (await git(repoDir, "diff", "--name-only", before, after)).stdout.split("\n").filter(Boolean);
  return { moved: true, changedPaths };
}

export function schedulerChanged(paths: string[]): boolean {
  return paths.some((p) => p.startsWith("tools/scheduler/"));
}
```

`tools/scheduler/src/service/inhibit.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export class SleepInhibitor {
  #enabled: boolean;
  #bin: string;
  #spawn: typeof nodeSpawn;
  #child: ChildProcess | null = null;

  constructor(opts: { enabled: boolean; bin?: string; spawn?: typeof nodeSpawn }) {
    this.#enabled = opts.enabled;
    this.#bin = opts.bin ?? "systemd-inhibit";
    this.#spawn = opts.spawn ?? nodeSpawn;
  }

  get held(): boolean {
    return this.#child !== null;
  }

  acquire(): void {
    if (!this.#enabled || this.#child) return;
    const child = this.#spawn(this.#bin, ["--what=sleep:idle", "--who=panelator-scheduler", "--why=stage in flight", "--mode=block", "sleep", "infinity"], { stdio: "ignore" });
    child.on("exit", () => {
      if (this.#child === child) this.#child = null;
    });
    child.unref();
    this.#child = child;
  }

  release(): void {
    const c = this.#child;
    this.#child = null;
    c?.kill();
  }
}
```

`tools/scheduler/src/service/log.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class ServiceLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  write(rec: Record<string, unknown>): void {
    appendFileSync(this.path, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
  }
  tick(info: Record<string, unknown>): void {
    this.write({ kind: "tick", ...info });
  }
  stopped(reason: string): void {
    this.write({ kind: "stopped", reason });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/service-helpers.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/service/git.ts tools/scheduler/src/service/inhibit.ts tools/scheduler/src/service/log.ts tools/scheduler/test/service-helpers.test.ts
git commit -m "scheduler: ff-only freshness, sleep inhibitor and service log trailers (AC-17, AC-30, AC-31)"
```

---

### Task 7: The poll loop

**Files:**
- Create: `tools/scheduler/src/service/loop.ts`
- Test: `tools/scheduler/test/loop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SchedulerDeps extends DriverDeps {
    botLogin: string; serviceLog: ServiceLog; inhibitor: SleepInhibitor;
    fastForward: () => Promise<{ moved: boolean; changedPaths: string[] }>;   // injectable
    sleep: (ms: number) => Promise<void>;                                    // injectable
    monotonic: () => number;                                                 // ms, does not advance during suspend (process.hrtime based)
    requestRestart: () => void;                                              // bin exits 75 once chains are idle
  }
  class Scheduler {
    constructor(deps: SchedulerDeps)
    tick(): Promise<TickInfo>          // one poll, serialized: at most one in progress
    run(): Promise<void>               // loop until stop(); tick immediately, then every poll_interval_s; a wake from sleep (wall clock jumped by more than one interval while monotonic did not) ticks at once (AC-4)
    stop(reason: string): void         // SIGTERM path: no new ticks or claims; in-flight chains finish their current stage; `stopped` trailer; run() resolves (AC-31)
    get active(): number
  }
  interface TickInfo { eligible: number; claimed: number[]; released: number[]; errors: string[]; restartPending: boolean }
  ```
  `tick()` in order: (1) `fetchOrigin` + `fastForward`; if `schedulerChanged`, set `restartPending` (restart happens when `active === 0`, via `requestRestart`). (2) `pruneUsage`. (3) Liveness over `listClaims()` not currently driven in this process: GitHub wins if `in-progress` is absent (review focus 2) → drop claim and save patch; else `livenessGate(max(last_activity_at, issueActivityAt), run_id !== null, now, liveness_hours)` → on expiry `transition(liveness_expired)` and apply its actions through the driver's `applyActions` (export it from `driver.ts`). (4) Resume claims on disk that are not active (after a restart): start `driveChain` for each, up to `slots`. (5) If free slots remain and not stopping: `listOpenIssues` → `selectEligible` → label-and-notify for each `label` decision (`gh.addLabels`, `gh.comment` naming the missing part, `notifier.notify`) → `rankIssues` with `recentMerges` → claim the first `free` issues: `addLabels([in-progress])`, `ensureWorktree`, `writeClaim`, start `driveChain` in the background (not awaited) with `active++`/`active--` and the inhibitor acquired while `active > 0`. (6) Log `tick`.
  A chain whose `driveChain` returns `waiting` is simply picked up again on the next tick by step (4), which is how `verify` re-polls (AC-14) and `waiting` resumes (AC-25). Because `driveChain` runs the next stage immediately after a stage exits, AC-3 holds without any timer.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/loop.test.ts`:

```ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { initialChainState } from "../src/chain/machine.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
const issue = (n: number, labels = ["validated", "class:product"]) => ({ number: n, title: `i${n}`, body: "Spec: specs/010-thing/spec.md", user: BOT, labels: labels.map((name) => ({ name })), created_at: `2026-10-0${n}T00:00:00Z`, updated_at: "2026-10-12T00:00:00Z" });

function routes(issues: unknown[], labelsNow: Record<number, string[]> = {}): Route[] {
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: issues, headers: pageLink(url, 1, 1) }) },
    { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: issues.length } } } } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/\d+\/timeline$/, reply: () => ({ body: [] }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)$/, reply: (m) => ({ body: { ...issue(Number(m[1])), labels: (labelsNow[Number(m[1])] ?? ["validated", "in-progress"]).map((name) => ({ name })) } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/\d+\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: {} }) },
  ];
}

async function setup(rs: Route[], slots = 1) {
  const pair = repoPair({ "a.txt": "a\n", "specs/010-thing/spec.md": spec });
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const gh = mockGitHub(rs);
  const notifications: Notification[] = [];
  const started: number[] = [];
  let now = new Date("2026-10-12T12:00:00Z");
  let mono = 0;
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", slots, state_dir: paths.root, poll_interval_s: 5 };
  const deps: SchedulerDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    // the "chain" here is a stub: it records the issue and parks the claim in verify so the test controls time
    adapterFor: () => { throw new Error("not used"); }, systemdScope: false, now: () => now, log: () => {},
    fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
    fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => mono, requestRestart: () => { started.push(-1); },
  };
  const s = new Scheduler(deps, { driveChain: async (_d, claim) => { started.push(claim.issue); return { ...claim, state: { ...claim.state, stage: "verify" } }; } });
  return { s, deps, gh, notifications, started, paths, pair, setNow: (d: Date) => { now = d; }, setMono: (m: number) => { mono = m; } };
}

describe("Scheduler.tick", () => {
  it("claims only as many issues as there are slots, in rank order, and labels the rest of the decisions (AC-1, AC-2, AC-5)", async () => {
    const { s, gh, started, paths } = await setup(routes([issue(2), issue(1), issue(3, ["validated"])]));
    const t = await s.tick();
    expect(t.claimed).toEqual([1]);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([1]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([1]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")?.body).toEqual({ labels: ["in-progress"] });
    const t2 = await s.tick();
    expect(t2.claimed).toEqual([]);
  }, 30_000);

  it("claims two with slots: 2", async () => {
    const { s } = await setup(routes([issue(2), issue(1)]), 2);
    expect((await s.tick()).claimed).toEqual([1, 2]);
  }, 30_000);

  it("labels needs-spec and notifies for an issue whose spec is missing (AC-7)", async () => {
    const bad = { ...issue(4), body: "Spec: specs/999-none/spec.md" };
    const { s, gh, notifications } = await setup(routes([bad]));
    await s.tick();
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/4/labels")?.body).toEqual({ labels: ["needs-spec"] });
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/4/comments")?.body).toMatchObject({ body: expect.stringContaining("not found on main") });
    expect(notifications).toEqual([expect.objectContaining({ issue: 4, label: "needs-spec" })]);
  }, 30_000);

  it("does not claim when the issue list is incomplete (review focus 1)", async () => {
    const rs = routes([issue(1)]);
    rs[1] = { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 3 } } } } }) };
    const { s } = await setup(rs);
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(t.errors[0]).toMatch(/incomplete/);
  }, 30_000);

  it("releases a stale claim whose issue lost in-progress on GitHub (review focus 2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("releases a claim with no run and no activity for the liveness window, saving a patch (AC-15)", async () => {
    const { s, deps, paths, pair, gh, setNow } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "implement" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(readdirSync(paths.patches)).toHaveLength(1);
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/labels/in-progress"))).toBeTruthy();
  }, 30_000);

  it("resumes a claim found on disk after a restart (AC-31)", async () => {
    const { s, deps, paths, pair, started } = await setup(routes([]));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([7]);
  }, 30_000);

  it("flags a restart when tools/scheduler changed on main (AC-17)", async () => {
    const { s, deps, started } = await setup(routes([]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(started).toEqual([-1]);
  }, 30_000);
});

describe("Scheduler.run", () => {
  it("ticks immediately, again after a detected sleep, and writes the stopped trailer on stop (AC-4, AC-31)", async () => {
    const { s, deps, paths, setNow, setMono } = await setup(routes([]));
    let ticks = 0;
    const origTick = s.tick.bind(s);
    s.tick = async () => { ticks++; return origTick(); };
    const sleeps: number[] = [];
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) { setNow(new Date("2026-10-12T13:00:00Z")); setMono(1000); } // wall jumped an hour, monotonic 1 s: slept
      if (sleeps.length === 2) s.stop("SIGTERM");
    };
    await s.run();
    expect(ticks).toBe(2);
    const log = readFileSync(paths.serviceLog, "utf8");
    expect(log).toContain('"kind":"resumed"');
    expect(log.trim().split("\n").pop()).toContain('"kind":"stopped"');
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/loop.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/service/loop.ts`:

```ts
import { applyActions, driveChain as defaultDriveChain, type DriverDeps } from "../chain/driver.ts";
import { initialChainState, transition } from "../chain/machine.ts";
import { livenessGate } from "../gates/index.ts";
import { ensureWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { buildSelectContext } from "../shortlist/fetch.ts";
import { rankIssues } from "../shortlist/rank.ts";
import { selectEligible } from "../shortlist/select.ts";
import { listClaims, removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { recentMerges } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import { pruneUsage } from "../state/runs.ts";
import type { SleepInhibitor } from "./inhibit.ts";
import type { ServiceLog } from "./log.ts";
import { schedulerChanged } from "./git.ts";

export interface SchedulerDeps extends DriverDeps {
  botLogin: string;
  serviceLog: ServiceLog;
  inhibitor: SleepInhibitor;
  fastForward: () => Promise<{ moved: boolean; changedPaths: string[] }>;
  sleep: (ms: number) => Promise<void>;
  monotonic: () => number;
  requestRestart: () => void;
}

export interface TickInfo {
  eligible: number;
  claimed: number[];
  released: number[];
  errors: string[];
  restartPending: boolean;
}

type DriveFn = (deps: DriverDeps, claim: Claim, isStopping: () => boolean) => Promise<Claim>;

export class Scheduler {
  #deps: SchedulerDeps;
  #drive: DriveFn;
  #active = new Map<number, Promise<void>>();
  #stopping = false;
  #stopReason = "";
  #ticking = false;
  #restartPending = false;

  constructor(deps: SchedulerDeps, opts: { driveChain?: DriveFn } = {}) {
    this.#deps = deps;
    this.#drive = opts.driveChain ?? defaultDriveChain;
  }

  get active(): number {
    return this.#active.size;
  }

  stop(reason: string): void {
    this.#stopping = true;
    this.#stopReason = reason;
  }

  #start(claim: Claim): void {
    if (this.#active.has(claim.issue)) return;
    const d = this.#deps;
    d.inhibitor.acquire();
    const p = this.#drive(d, claim, () => this.#stopping)
      .catch((e) => d.log({ kind: "error", issue: claim.issue, error: (e as Error).message }))
      .finally(() => {
        this.#active.delete(claim.issue);
        if (this.#active.size === 0) {
          d.inhibitor.release();
          if (this.#restartPending) d.requestRestart();
        }
      });
    this.#active.set(claim.issue, p);
  }

  async #liveness(claim: Claim, errors: string[]): Promise<boolean> {
    const d = this.#deps;
    const labels = await d.gh.issueLabels(claim.issue).catch((e) => { errors.push(`labels ${claim.issue}: ${(e as Error).message}`); return null; });
    if (labels === null) return false;
    if (!labels.includes(d.cfg.labels.claim)) {
      d.log({ kind: "stale-claim", issue: claim.issue });
      await savePatch(d.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""));
      await removeClaim(d.paths, claim.issue);
      return true;
    }
    const ghActivity = await d.gh.issueActivityAt(claim.issue).catch(() => claim.last_activity_at);
    const last = ghActivity > claim.last_activity_at ? ghActivity : claim.last_activity_at;
    const g = livenessGate(last, claim.run_id !== null, d.now(), d.cfg.liveness_hours);
    if (g.ok) return false;
    const { state, actions } = transition(claim.state, { type: "liveness_expired" });
    await applyActions(d, { ...claim, state }, actions);
    return true;
  }

  async tick(): Promise<TickInfo> {
    if (this.#ticking) return { eligible: 0, claimed: [], released: [], errors: ["tick already in progress"], restartPending: this.#restartPending };
    this.#ticking = true;
    const d = this.#deps;
    const info: TickInfo = { eligible: 0, claimed: [], released: [], errors: [], restartPending: this.#restartPending };
    try {
      try {
        await d.fetchOrigin();
        const ff = await d.fastForward();
        if (ff.moved && schedulerChanged(ff.changedPaths)) {
          this.#restartPending = true;
          info.restartPending = true;
          if (this.#active.size === 0) d.requestRestart();
        }
      } catch (e) {
        info.errors.push(`freshness: ${(e as Error).message}`);
      }
      await pruneUsage(d.paths, d.now()).catch((e) => info.errors.push(`prune: ${(e as Error).message}`));

      for (const claim of await listClaims(d.paths)) {
        if (this.#active.has(claim.issue)) continue;
        if (await this.#liveness(claim, info.errors)) info.released.push(claim.issue);
      }
      if (this.#stopping) return info;

      for (const claim of await listClaims(d.paths)) {
        if (this.#active.size >= d.cfg.slots) break;
        if (!this.#active.has(claim.issue) && !(claim.state.stage === "waiting" && claim.state.postponedUntil && new Date(claim.state.postponedUntil) > d.now())) this.#start(claim);
      }

      const free = d.cfg.slots - this.#active.size;
      if (free <= 0) return info;
      let issues;
      try {
        issues = await d.gh.listOpenIssues();
      } catch (e) {
        info.errors.push((e as Error).message);
        return info;
      }
      const claimed = new Set((await listClaims(d.paths)).map((c) => c.issue));
      const { eligible, decisions } = selectEligible(issues, buildSelectContext(d.repoDir, d.cfg, claimed, d.botLogin));
      info.eligible = eligible.length;
      for (const dec of decisions) {
        if (dec.result.ok || dec.result.action !== "label") continue;
        const r = dec.result;
        await d.gh.addLabels(dec.issue, [r.label]).catch((e) => info.errors.push(`label ${dec.issue}: ${(e as Error).message}`));
        await d.gh.comment(dec.issue, `${r.label}: ${r.reason}`).catch((e) => info.errors.push(`comment ${dec.issue}: ${(e as Error).message}`));
        await d.notifier.notify({ issue: dec.issue, gate: dec.gate, label: r.label, text: r.reason });
      }
      const ranked = rankIssues(eligible, d.cfg.labels, await recentMerges(d.paths, d.now()));
      for (const issue of ranked.slice(0, free)) {
        if (this.#stopping) break;
        try {
          await d.gh.addLabels(issue.number, [d.cfg.labels.claim]);
          const wt = await ensureWorktree(d.repoDir, d.paths.worktrees, issue.number);
          const claim: Claim = {
            issue: issue.number, slot: this.#active.size, state: initialChainState(issue.number), worktree: wt.path,
            started_at: d.now().toISOString(), last_activity_at: d.now().toISOString(), run_id: null,
          };
          await writeClaim(d.paths, claim);
          info.claimed.push(issue.number);
          this.#start(claim);
        } catch (e) {
          info.errors.push(`claim ${issue.number}: ${(e as Error).message}`);
        }
      }
      return info;
    } finally {
      this.#ticking = false;
      d.serviceLog.tick({ ...info, active: [...this.#active.keys()] });
    }
  }

  async run(): Promise<void> {
    const d = this.#deps;
    const intervalMs = d.cfg.poll_interval_s * 1000;
    let lastWall = d.now().getTime();
    let lastMono = d.monotonic();
    while (!this.#stopping) {
      await this.tick().catch((e) => d.log({ kind: "error", error: (e as Error).message }));
      lastWall = d.now().getTime();
      lastMono = d.monotonic();
      await d.sleep(intervalMs);
      const wall = d.now().getTime() - lastWall;
      const mono = d.monotonic() - lastMono;
      if (wall - mono > intervalMs) d.serviceLog.write({ kind: "resumed", slept_ms: wall - mono });
    }
    await Promise.allSettled([...this.#active.values()]);
    d.serviceLog.stopped(this.#stopReason);
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tools/scheduler/test/loop.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 9 passed; tsc clean. If "claims only as many issues" sees `started` empty, the drive stub runs on the microtask queue; the 50 ms wait covers it.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/service/loop.ts tools/scheduler/src/chain/driver.ts tools/scheduler/test/loop.test.ts
git commit -m "scheduler: poll loop with slots, liveness, stale-claim handling, sleep detection, self-update flag and stop (AC-1 to AC-5, AC-15, AC-17, AC-31)"
```

---

### Task 8: Entry point and systemd unit

**Files:**
- Create: `tools/scheduler/bin/scheduler.ts`
- Create: `tools/scheduler/systemd/panelator-scheduler.service`
- Modify: `tools/README.md`

**Interfaces:**
- `bin/scheduler.ts` flags: `--config <path>` (default `agents/scheduler.yaml`), `--check-auth` (print bot login and token expiry, exit), `--once` (one tick, wait for the chains it started, then exit; for the AC-29 run). Wires: `loadConfig`, `statePaths` + `ensureStateDirs`, `createAppClient` (private key from `cfg.app.private_key_path`), `refreshTokenFile` + `startTokenRefresh`, `GitHubClient`, `LogNotifier` wrapped in `rateLimited`, `loadStageDefinitions`, `SleepInhibitor({ enabled: cfg.systemd.inhibit })`, `ServiceLog`, `Scheduler`. `requestRestart` exits with code 75 after the service log line `{"kind":"restart"}`. SIGTERM and SIGINT call `scheduler.stop(signal)`.

- [ ] **Step 1: Write the entry point**

`tools/scheduler/bin/scheduler.ts`:

```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../src/adapters/index.ts";
import { agentsDir, defaultConfigPath, loadConfig, repoRoot } from "../src/config.ts";
import { createAppClient } from "../src/github/auth.ts";
import { GitHubClient } from "../src/github/client.ts";
import { LogNotifier } from "../src/notify/log.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { fastForwardMain, fetchOrigin } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { ServiceLog } from "../src/service/log.ts";
import { Scheduler } from "../src/service/loop.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

const cfg = loadConfig(flag("--config") ?? defaultConfigPath);
const paths = statePaths(cfg.state_dir);
await ensureStateDirs(paths);
const serviceLog = new ServiceLog(paths.serviceLog);
const binDir = dirname(fileURLToPath(import.meta.url));

const app = createAppClient(cfg.app, readFileSync(cfg.app.private_key_path, "utf8"));
const token = await app.refreshTokenFile(paths);
const botLogin = await app.botLogin();
if (has("--check-auth")) {
  console.log(`bot ${botLogin}, token expires ${token.expires_at}`);
  process.exit(0);
}
const stopRefresh = app.startTokenRefresh(paths);
const gh = new GitHubClient(app.octokit, cfg.repo);

const scheduler = new Scheduler({
  cfg, paths, gh, notifier: rateLimited(new LogNotifier(paths.serviceLog), cfg.notify_rate_limit_hours),
  stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: repoRoot, binDir,
  adapterFor: (h) => adapterFor(h), systemdScope: cfg.systemd.scope, now: () => new Date(),
  log: (rec) => serviceLog.write(rec), fetchOrigin: () => fetchOrigin(repoRoot),
  botLogin, serviceLog, inhibitor: new SleepInhibitor({ enabled: cfg.systemd.inhibit }),
  fastForward: () => fastForwardMain(repoRoot), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
  requestRestart: () => { serviceLog.write({ kind: "restart", reason: "tools/scheduler changed on main" }); stopRefresh(); process.exit(75); },
});

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => scheduler.stop(sig));

if (has("--once")) {
  const info = await scheduler.tick();
  console.log(JSON.stringify(info));
  scheduler.stop("once");
}
await scheduler.run();
stopRefresh();
```

`tools/scheduler/systemd/panelator-scheduler.service`:

```ini
[Unit]
Description=panelator scheduler (spec 001)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Projects/panelator
Environment=CI=true
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node tools/scheduler/bin/scheduler.ts
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=5400

[Install]
WantedBy=default.target
```

Append to `tools/README.md`:

```markdown
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.
```

`TimeoutStopSec` is the longest stage timeout (implement, 90 min) so a stop lets the in-flight stage finish (AC-31). Node 26 must be first on `PATH` for the `.ts` entry point and the credential helper; adjust the `Environment=PATH` line to wherever `node --version` reports 26 on the laptop.

- [ ] **Step 2: Smoke-run the binary without the App**

Run: `node tools/scheduler/bin/scheduler.ts --config /nonexistent 2>&1 | head -3`
Expected: an ENOENT error for the config path and a non-zero exit, proving the file parses and runs under Node's type stripping.

- [ ] **Step 3: Typecheck and run the whole suite**

Run: `pnpm -F @panelator/scheduler typecheck && pnpm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tools/scheduler/bin/scheduler.ts tools/scheduler/systemd tools/README.md
git commit -m "scheduler: entry point with --check-auth and --once, systemd user unit (spec section 14)"
```

---

### Task 9: Recorded end-to-end test

**Files:**
- Test: `tools/scheduler/test/e2e.test.ts`

**Interfaces:** consumes everything above. Asserts the label and comment sequence and the records written (spec section 16, "a recorded end-to-end test drives a full chain with the fake adapter and a mocked GitHub API").

- [ ] **Step 1: Write the test**

`tools/scheduler/test/e2e.test.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters/types.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl");
const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const SHA = "c".repeat(40);
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };

function scripted(results: Record<string, unknown[]>): Adapter & { ran: string[] } {
  const ran: string[] = [];
  return {
    harness: "fake", ran,
    buildCommand(run) {
      ran.push(run.stage);
      const r = results[run.stage]?.shift();
      const argv = [process.execPath, script, events, run.resultPath, r === undefined ? "1" : "0", "0"];
      if (r !== undefined) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, t) => t ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null } : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : { outcome: "failed", reason: "exit", apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

describe("end to end: one issue through the whole chain with the fake adapter and a mocked GitHub", () => {
  it("claims, plans, implements, verifies, reviews, merges, and leaves the records (AC-1, AC-3, AC-24, AC-29 shape)", async () => {
    const pair = repoPair({ "a.txt": "a\n", "specs/010-thing/spec.md": spec });
    const paths = statePaths(join(pair.root, "state"));
    await ensureStateDirs(paths);
    const labels = new Set(["validated", "class:product"]);
    const comments: string[] = [];
    const labelLog: string[] = [];
    const issue = () => ({ number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", user: BOT, labels: [...labels].map((name) => ({ name })), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" });
    const routes: Route[] = [
      { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: [issue()], headers: pageLink(url, 1, 1) }) },
      { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 1 } } } } }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7\/timeline$/, reply: () => ({ body: [] }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: issue() }) },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: (_m, b) => { for (const l of (b as { labels: string[] }).labels) { labels.add(l); labelLog.push(`+${l}`); } return { body: [] }; } },
      { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/([^/]+)$/, reply: (m) => { labels.delete(m[1]); labelLog.push(`-${m[1]}`); return { body: {} }; } },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: (_m, b) => { comments.push((b as { body: string }).body); return { status: 201, body: {} }; } },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, head: { sha: SHA }, html_url: "u", mergeable: true, mergeable_state: "clean", merged: false, state: "open" } }) },
      { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
      { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
    ];
    const gh = mockGitHub(routes);
    const notifications: Notification[] = [];
    const adapter = scripted({
      plan: [{ verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }], findings: [{ what: "w", where: "a.txt:1", evidence: "e", noticed_how: "n" }] }],
      implement: [{ pr_number: 9, head_sha: SHA, tasks_done: ["T1"] }],
      review: [{ verdict: "approve", findings_on_pr: [], declined_to_judge: [] }],
    });
    const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root, slots: 1 };
    const deps: SchedulerDeps = {
      cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
      notifier: { notify: async (n) => { notifications.push(n); } },
      stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
      adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: () => {},
      fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
      botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
      fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => 0, requestRestart: () => {},
    };
    const s = new Scheduler(deps);
    const t = await s.tick();
    expect(t.claimed).toEqual([7]);
    // wait for the background chain to finish
    for (let i = 0; i < 200 && s.active > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.active).toBe(0);

    expect(adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(comments).toEqual([]);
    expect(notifications).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(existsSync(join(paths.worktrees, "issue-7"))).toBe(false);
    const usage = readdirSync(paths.usage).sort();
    expect(usage).toHaveLength(3);
    for (const f of usage) {
      const rec = JSON.parse(readFileSync(join(paths.usage, f), "utf8"));
      expect(rec).toMatchObject({ issue: 7, outcome: "ok", harness: "fake", cost_usd: 0.1 });
      expect(existsSync(join(paths.root, rec.events_path))).toBe(true);
    }
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"issue":7');
    const ticks = readFileSync(paths.serviceLog, "utf8").split("\n").filter((l) => l.includes('"kind":"tick"'));
    expect(ticks).toHaveLength(1);
  }, 120_000);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tools/scheduler/test/e2e.test.ts`
Expected: 1 passed. If the merge step reports the PR not mergeable, check that `pullRequest` returns `mergeable: true` from the mock route; if the worktree still exists, `removeWorktree` failed because the test's `repoPair` checkout is not the worktree's parent repo: the worktree was created from `pair.repo`, so `removeWorktree(deps.repoDir, ...)` must use the same path.

- [ ] **Step 3: Run the full suite and typecheck, then commit**

Run: `pnpm test && pnpm -F @panelator/scheduler typecheck`
Expected: all pass.

```bash
git add tools/scheduler/test/e2e.test.ts
git commit -m "scheduler: recorded end-to-end chain with the fake adapter and a mocked GitHub (spec section 16)"
```

---

### Task 10: AC-29, by hand

No automated test. Done once by the maintainer with the real App, the real harnesses and a trivial spec. Record everything in `dev-logs/<date>-spec-001-ac29.md`.

- [ ] **Step 1: Write a trivial spec and issue**

Create `specs/002-ac29-smoke/spec.md` following section 10 with domain `backend`, one criterion ("Given the repo, when `pnpm test` runs, then a new test file `tools/scheduler/test/smoke-ac29.test.ts` passes asserting `1 + 1 === 2`"), Interfaces listing that file, Verification `pnpm test`, Open decisions `None.` Commit it to `main` (push this one commit; the pipeline reads specs from `origin/main`).

Create the issue as the App (so the Authority gate passes without the maintainer label):

```bash
TOKEN=$(node -e 'const t=require(process.env.HOME+"/.local/state/panelator-scheduler/token.json");console.log(t.token)')
GH_TOKEN=$TOKEN gh issue create -R adam26davidson/panelator --title "AC-29 smoke: trivial test" --label validated --label class:tooling \
  --body $'Smoke run of spec 001 AC-29.\n\nSpec: specs/002-ac29-smoke/spec.md'
```

(Run `node tools/scheduler/bin/scheduler.ts --check-auth` first so `token.json` exists.)

- [ ] **Step 2: Run one tick in the foreground and watch**

```bash
node tools/scheduler/bin/scheduler.ts --once
tail -f ~/.local/state/panelator-scheduler/log/service.jsonl
```

Expected sequence in the log: `tick` with `claimed: [N]`, then `stage` records for plan, implement, review with `outcome: "ok"`, a `transition` to `merge`, then `done`. On GitHub: the issue gets `in-progress`, a PR appears from `issue-N` authored by the bot, CI runs, the PR squash-merges, the issue closes, `in-progress` is removed.

- [ ] **Step 3: Verify the records (AC-24, AC-29)**

```bash
ls ~/.local/state/panelator-scheduler/usage/ | grep "^$N-"
for f in ~/.local/state/panelator-scheduler/usage/$N-*.json; do node -e "const r=require('$f');console.log(r.stage,r.outcome,r.harness,r.model,r.cost_usd,r.turns,r.wall_seconds)"; done
```

Expected: three records (plan, implement, review), each with cost, tokens, turns and the events path, matching the usage record schema.

- [ ] **Step 4: Write the dev-log**

`dev-logs/<date>-spec-001-ac29.md` with: the issue and PR numbers, the three usage records' numbers (cost, tokens, turns, wall time per stage), anything that needed a manual nudge, and the wall time from claim to merge. Note any deviation from the spec and file it as a finding in `findings/queue.jsonl` by hand if it is debt.

- [ ] **Step 5: Install the service and start the soak** (spec section 16)

```bash
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now panelator-scheduler
systemctl --user status panelator-scheduler
```

The service runs for one week with `slots: 1` before any profile beyond `backend` is enabled; the usage records from that week are the first dataset for piece E. Add the start date to the dev-log.

- [ ] **Step 6: Commit the dev-log and the smoke spec**

```bash
git add dev-logs/*-spec-001-ac29.md specs/002-ac29-smoke
git commit -m "dev-logs: spec 001 AC-29 run against the real repo and harnesses"
```

---

## Self-review against the spec

- Section 4 modules: `github/` (Tasks 2, 3), `service/` (Tasks 6, 7, 8); `shortlist/` fetch side (Task 4); the driver completes `chain/` (Task 5).
- Section 7 shortlist stub: listing with full pagination and the count assertion (Task 3), selection and ranking from plan 1, the 2:1 ratio fed from the merges record (Task 4).
- Section 8 gates driven here: Verify (Task 3 `checks`, Task 5 `verifyEvent`), Liveness (Task 7), Freshness (Tasks 6, 7), Sensitive path (Task 5 picks the `security` profile and passes `security` into the review event).
- Section 12: App permissions and creation (Task 1), token refresh every 50 minutes (Task 2); the shim and credential helper are plan 2.
- Section 14: systemd user service with `Restart=on-failure`, `WantedBy=default.target` (Task 8); transient scopes and `MemoryMax=50%`, `OOMPolicy=continue`, `KillMode=control-group` are plan 2's `scopeArgv`, enabled by `cfg.systemd.scope`; `systemd-inhibit --what=sleep:idle` (Task 6); ff-only before each poll and restart after in-flight stages finish (Tasks 6, 7, 8); `CI=true` on every stage (plan 2 adapters) and on the unit; poll 45 s and `slots: 1` from `agents/scheduler.yaml`.
- Section 16 verification: vitest suite (all tasks), recorded end-to-end (Task 9), AC-29 by hand (Task 10), one-week soak (Task 10 step 5).
- AC coverage in this plan: AC-1, AC-2, AC-3, AC-4, AC-5, AC-7 (labelling side), AC-14, AC-15, AC-16 (driver side), AC-17, AC-25 (driver side), AC-27 (notifications wired), AC-29, AC-30 (inhibitor), AC-31. With plans 1 and 2, every AC-1 to AC-31 has an owning test or the AC-29 manual record.
- Added outside the spec's file list, flagged in Task 1: `.github/workflows/ci.yml` and the `required_checks` config field, because AC-14 cannot be met on a repository with no checks.
