# 082. The filer's open-issue listings fetch no label events

Status: written 2026-11-18 from the delivery-system design for issue #160;
specs derived from that design need no maintainer approval (design section 11).
Supersedes and amends no earlier spec's text.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[process spec](../../docs/process-spec.md) section 6.4 (the completeness
principle: full pagination and the asserted total, which this spec keeps);
[031-design-files-children](../031-design-files-children/spec.md) AC-3 (the
`listIssues` listing, whose `labelEvents: false` option was added for the
children scan and which this spec reuses);
[037-filer-apply-lists-open-issues-once](../037-filer-apply-lists-open-issues-once/spec.md)
section 2 (which reduced the number of listings and left the client's
per-issue cost alone; this spec removes that cost).

## 1. Goal

`GitHubClient.listIssues` (`tools/scheduler/src/github/client.ts`) fetches
each issue's timeline, one paginated request per issue, to fill
`IssueData.labelEvents`, unless the caller passes `labelEvents: false`. The
three filer wrappers, `listOpenIssuesByLabel`, `listOpenIssuesByAuthor` and
`searchOpenIssuesByMarker`, call `listOpenIssues()`, which passes no option,
so each of their listings costs one issue page plus the GraphQL total plus
one timeline request for every open issue. With 43 open issues, the two
listings in one filer run (`buildFilerInput`'s `listOpenIssuesByAuthor` and
`listOpenIssuesByLabel('abandoned')`, `tools/scheduler/src/filer/input.ts`)
cost about 90 requests instead of 4. Applying the result adds another
listing (`applyDecisions`' memoised `openBotIssues`,
`tools/scheduler/src/filer/apply.ts`) at the same cost.

None of these callers reads `labelEvents`. `grep -rn labelEvents
tools/scheduler/src/filer` finds only apply.ts's `listIssues({ state: 'all',
labelEvents: false })` (spec 066) and the `labelEvents: []` that `created`
writes into its in-memory copy of an issue it just filed. The readers of
`labelEvents` (`gates/authority.ts` and `#recordEligible` in
`service/loop.ts`) are fed by the shortlist's direct `listOpenIssues()` in
`service/loop.ts`. That call keeps fetching label events.

After this spec, the three wrappers list with `labelEvents: false`. Each of
their listings costs the issue pages and the GraphQL total, and nothing per
issue.

## 2. Out of scope

- `listOpenIssues()` and its callers. The shortlist's listing still attaches
  label events for the authority gate (process spec 4.3) and for
  `issue.eligible`'s `validated_at` (spec 012 AC-1).
- `listIssues` itself. Its listing, settle delays (spec 014 AC-7) and
  completeness assertion (process spec 6.4) are unchanged, and so is the
  meaning of `labelEvents: false`.
- How many listings the filer makes (spec 037).
- Making label events lazy or cached in the client. No caller of the
  wrappers needs them, so the wrappers skip them outright.
- The findings-filer prompt (`agents/standing/findings-filer.md`).

## 3. Acceptance criteria

AC-1. **The wrappers skip the timeline.** Given a repository whose open
issues are listed in one page, when `listOpenIssuesByLabel(label)`,
`listOpenIssuesByAuthor(login)` or `searchOpenIssuesByMarker(marker)` is
called, then the client requests the issue list and the GraphQL total
exactly as `listOpenIssues()` does (the same pagination, settle delays and
"issue list incomplete" error), makes no request to
`/repos/{owner}/{repo}/issues/{n}/timeline` for any issue, and returns the
same issues as before, filtered as before, each with `labelEvents: []`.

AC-2. **The shortlist's listing is unchanged.** Given the same repository,
when `listOpenIssues()` is called, then it still makes one timeline request
per open issue and attaches the label events, as the existing
"paginates fully, drops pull requests, and attaches label events" test in
`tools/scheduler/test/client.test.ts` asserts.

AC-3. **The filer's results do not change.** Given the scheduler's existing
filer tests (`test/filer.test.ts`, `test/filer-results.test.ts`,
`test/markers.test.ts`) and the e2e test, when they run against the changed
client, then they pass unchanged. They mock the three wrappers, and no code
under `tools/scheduler/src/filer/` reads `labelEvents`.

AC-4. **The filer's input carries empty label events.** Given an open issue
labelled `abandoned`, when `buildFilerInput` builds its `abandoned[]` record,
then the record's `issue.labelEvents` is `[]`. *(agent's call)* This is the
one place the change reaches past the scheduler's own code: the record's
`issue` is the full `IssueData` handed to the filer agent. The filer prompt
names no label history. It decides an abandoned issue from its comments,
ledgers and retry count (`agents/standing/findings-filer.md`, "For abandoned
issues use retry ..."), so the agent loses nothing it was told to use. The
record keeps the field, rather than dropping it, so the `AbandonedRecord`
type and the input's shape stay as they are.

## 4. Interfaces and files

- `tools/scheduler/src/github/client.ts`: the three wrappers call
  `this.listIssues({ state: "open", labelEvents: false })` in place of
  `this.listOpenIssues()`, and keep their filters. Their signatures and
  return type are unchanged. A short comment on them names this spec
  (AC-1). `listOpenIssues()` and `listIssues` are unchanged.
- `tools/scheduler/test/client.test.ts`: a new test (AC-1) in the
  `listOpenIssues` describe block or a new one beside it. It uses the file's
  `mockGitHub` routes with no timeline route: one issue page holding issues
  that differ in author, labels and body, and the GraphQL total. It calls
  each of the three wrappers and asserts:
  - the filtered issue numbers;
  - `labelEvents` is `[]` on every returned issue;
  - no recorded call's URL contains `/timeline`;
  - `gh.unmatched` is empty.
- No other file under `tools/scheduler/src/` changes, and no existing
  assertion is removed or weakened.

The spec PR adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so
the security review applies to the implementation PR (spec 006 AC-9). The
change narrows what three listings fetch. It touches no gate: the
authority gate's listing is AC-2's, and it is unchanged.

## 5. Verification

- `pnpm test` from the repository root passes.
- The new client test covers AC-1. The existing `listOpenIssues` test
  covers AC-2. The unchanged filer, marker and e2e tests cover AC-3 and
  AC-4.
- `grep -n "listOpenIssues()" tools/scheduler/src/github/client.ts` finds
  only `listOpenIssues`'s own definition, not the three wrappers.
- `git diff main --stat` touches only `tools/scheduler/src/github/client.ts`
  and `tools/scheduler/test/client.test.ts`.

## 6. Open decisions

None.
