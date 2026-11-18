# 082. The filer's open-issue listings skip the label events

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
principle: a listing paginates fully and asserts the total; kept here);
[031-design-files-children](../031-design-files-children/spec.md) AC-3
(`listIssues` and its `labelEvents: false` option, added for callers that do
not read the label events);
[037-filer-apply-lists-open-issues-once](../037-filer-apply-lists-open-issues-once/spec.md)
section 1 (a filer run makes at most two listings) and section 2 (it left
the client unchanged, which this spec now changes);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) section 2
(the per-issue timeline cost of the marker search, left out of scope there).

## 1. Goal

A listing made through the client's three filtered wrappers costs the
paginated issue listing and the GraphQL total, and no timeline request.
Today it also costs one timeline request per open issue.

The client (`tools/scheduler/src/github/client.ts`) has three wrappers.
Each one calls `listOpenIssues()` and filters the result:

- `listOpenIssuesByLabel`;
- `listOpenIssuesByAuthor`;
- `searchOpenIssuesByMarker`.

`listOpenIssues()` calls `listIssues({ state: "open" })` with no
`labelEvents` option. So `listIssues` fetches
`GET /repos/{owner}/{repo}/issues/{n}/timeline` (paginated) for every open
issue, before any filter runs. That fills `IssueData.labelEvents`.

The wrappers' only callers in `tools/scheduler/src/` are in the findings
filer:

- `buildFilerInput` (`filer/input.ts`) calls `listOpenIssuesByAuthor(botLogin)`
  once and `listOpenIssuesByLabel('abandoned')` once.
- `applyFilerResult` (`filer/apply.ts`) calls `listOpenIssuesByAuthor(botLogin)`
  at most once (spec 037).

None of them reads `labelEvents`. `searchOpenIssuesByMarker` has no caller
in `src/` since spec 037. The code that does read `labelEvents` gets its
issues elsewhere:

- the authority gate (`gates/authority.ts`), and
- `#recordEligible` in `service/loop.ts`, which reads the `validated`
  labelling time.

Both are fed by the loop's direct `d.gh.listOpenIssues()` call.

With 43 open issues, one filer run makes three listings (two to build the
input, one to apply). Each costs at least one page of issues and one GraphQL
query, plus 43 timeline requests. That is about 135 requests where 6 would
do.

The fix passes `labelEvents: false` in the three wrappers, the option spec 031
added for exactly this kind of caller. `listOpenIssues()` keeps fetching the
label events, because the shortlist and the authority gate need them.

We put the option in the wrappers, not at the filer's call sites. That keeps
the filer's dependency interface unchanged: the wrappers take a label, an
author or a marker and nothing else. It also covers
`searchOpenIssuesByMarker`, which spec 028 still lists among the reflection
apply's allowed operations. A wrapper that returns `labelEvents: []` is safe
because no code that reads label events uses a wrapper. A doc comment on
the wrappers says so, so that a later reader does not take the empty array
for real data. No ADR: the change is small, it reverses easily, and it has
one clearly right answer.

## 2. Out of scope

- `listOpenIssues()` and `listIssues()` themselves. Their pagination,
  GraphQL total assertion and re-list on mismatch (spec 014 AC-7) stay as
  they are. So does their default of fetching label events.
- The loop's shortlist listing (`service/loop.ts`, `d.gh.listOpenIssues()`)
  and what reads it: the authority gate, `#recordEligible` and the
  classifiers. These keep their label events.
- The children scan (`children/scan.ts`). It already passes
  `labelEvents: false`, and it fetches one issue's events itself when it
  needs them (spec 078).
- The number of listings a filer run makes (spec 037). This spec makes each
  listing cheaper. It does not make fewer of them.
- Removing `searchOpenIssuesByMarker` from the client. Spec 037 section 2
  and spec 028 AC-8 keep it.
- The filer's dependency type and its test mocks (`filer.test.ts`,
  `filer-results.test.ts`, `markers.test.ts`). They mock the wrappers
  directly, so the change does not reach them.

## 3. Acceptance criteria

AC-1. **The wrappers fetch no timeline.** Given a `GitHubClient` over the
mock GitHub, with two open issues whose labels, authors and bodies all match,
when `listOpenIssuesByLabel`, `listOpenIssuesByAuthor` or
`searchOpenIssuesByMarker` is called, then:

- the request log holds no `/timeline` request;
- each returned issue has `labelEvents` equal to `[]`;
- the result has the same `number`, `title`, `author`, `body`, `labels`,
  `createdAt` and `state` as before this change.

Each wrapper is tested on its own.

AC-2. **The wrappers keep the completeness check.** Given the mock answers
one issue while the GraphQL total reports a different count on every
attempt, and the client has zero settle delays, when any of the three
wrappers is called, then it rejects with `issue list incomplete: got 1,
server reports <n>`, as `listOpenIssues()` does (process-spec 6.4, spec 014
AC-7). One test, through `listOpenIssuesByAuthor`, is enough.

AC-3. **The wrappers still filter.** Given open issues that differ in label,
author and body, when each wrapper is called, then it returns only the
issues that:

- carry the label (`listOpenIssuesByLabel`);
- have that author (`listOpenIssuesByAuthor`);
- contain the marker in their body (`searchOpenIssuesByMarker`);

in listing order. This is unchanged from today, and it is asserted
alongside AC-1.

AC-4. **The unfiltered listing keeps its label events.** Given the existing
`listOpenIssues (process-spec 6.4)` test in `client.test.ts`, when it runs,
then it still asserts the label events built from each issue's timeline, and
it passes. The body of that test is not edited.

AC-5. **The wrappers say what they return.** Given `client.ts`, when a
reader looks at the three wrappers, then a doc comment above them says:

- they list the open issues as `listOpenIssues` does, without the label
  events (`labelEvents` is `[]`);
- a caller that reads `labelEvents` uses `listOpenIssues()`.

## 4. Interfaces and files

- `tools/scheduler/src/github/client.ts`. Each of the three wrappers calls
  `this.listIssues({ state: "open", labelEvents: false })` in place of
  `this.listOpenIssues()`, then applies its filter as before. The AC-5
  comment goes above them. No signature changes. `listOpenIssues` and
  `listIssues` are unchanged.
- `tools/scheduler/test/client.test.ts`. The only change to the existing
  `listOpenIssues` block that AC-4 allows is moving its route builders. A new `describe` block,
  "filtered open-issue listings (spec 082)", holds AC-1 to AC-3. It uses
  the file-level `issue` and `client` helpers. It also needs the
  `issuesRoute` and `total` route builders, which today are local to the
  `listOpenIssues` block. The implementer either moves them to file level
  unchanged or defines the same builders in the new block. The new block
  registers no timeline route. Without a route, a timeline request would be
  unmatched, and AC-1 asserts the log holds none. The AC-2 case builds its
  client with zero settle delays (`settleDelaysMs: []` or `[0, 0, 0]`), the
  same way the existing mismatch test does.
- No caller changes. `filer/input.ts`, `filer/apply.ts` and the loop are
  untouched.

The spec PR adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so
the security review applies to the implementation PR (spec 006 AC-9). The
change removes no check. The authority gate's input, the loop's
`listOpenIssues()`, is unchanged, and AC-4 keeps its test.

## 5. Verification

- `pnpm test` from the repository root passes.
- The new `client.test.ts` block covers AC-1 to AC-3. On `main` before
  this change, its AC-1 assertions fail: each wrapper requests one timeline
  per issue.
- `grep -n "listOpenIssues()" tools/scheduler/src/github/client.ts` finds
  no line for the three wrappers.
- `git diff main --stat` touches only `tools/scheduler/src/github/client.ts`
  and `tools/scheduler/test/client.test.ts`.

## 6. Open decisions

None.
