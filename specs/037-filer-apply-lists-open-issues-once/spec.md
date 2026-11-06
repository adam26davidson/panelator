# 037. Applying a filer result lists the open issues at most once

Status: written 2026-11-06 from the delivery-system design for issue #58;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[process spec](../../docs/process-spec.md) section 6.4 (the completeness
principle: deterministic scripts list with full pagination and assert the
total; this spec keeps that and runs it once);
[008-agent-registry](../008-agent-registry/spec.md) AC-16 (decisions are
applied in order), AC-18 (the hidden marker searched before an issue is
created; a `merge_into` whose target is closed or not bot-authored becomes a
`file`) and section 5 (the GitHub client calls);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) AC-4 (a
batch aborted half way keeps what it applied), AC-6 (the capability issue,
"looked up at most once per batch": the pattern this spec extends) and AC-7
(the listing re-lists before it fails); amends spec 008 AC-18 as section 4
records.

## 1. Goal

Applying one filer result costs at most one open-issue listing, whatever the
batch holds. Today the cost grows with the batch: every `file`, `escalate`
and `rewrite` decision lists the repository's open issues to look for an
earlier issue carrying the same ref's marker, and every `merge_into`
decision lists them again to check that its target is open and bot-authored.
Each listing is a full pagination plus the GraphQL total (process spec 6.4),
and a listing made right after this batch's own `createIssue` is exactly the
one that tends to see the REST page and the GraphQL total disagree, so it
also pays spec 014 AC-7's settle delays. A batch of 20 `file` decisions is
20 listings, and 19 of them happen seconds after an issue was created.

### What is wrong today

In `tools/scheduler/src/filer/apply.ts`, `applyDecisions` already memoises
one lookup: the capability issue is fetched at most once per batch, and only
when something is held (spec 014 AC-6). The two per-decision lookups beside
it are not memoised: `file()` calls
`d.gh.searchOpenIssuesByMarker('<!-- panelator-finding:')` each time it runs,
and the `merge_into` case calls `d.gh.listOpenIssuesByAuthor(d.botLogin)`
each time it runs. Both are `listOpenIssues` underneath
(`tools/scheduler/src/github/client.ts`): the same full listing, filtered
differently. Every issue the marker check or the merge check can accept is
bot-authored (the marker check filters on `author === botLogin`; the merge
check is defined as "open and bot-authored"), and the listing already
returns bodies, so one listing of the bot's open issues answers every lookup
in the batch locally. The review stage of issue #10 noticed it while tracing
the GitHub calls made while applying a filer result (findings queue ref 25).

### The fix

`applyDecisions` keeps one cache of the bot's open issues for the batch:
the result of one `listOpenIssuesByAuthor(botLogin)` call, fetched the
first time a decision needs it and never again in that batch. The marker
check, the merge-target check and the capability-issue lookup all read the
cache. The cache follows the batch's own writes, so it stays a faithful
view of the bot's open issues: an issue the batch creates is added, an
issue the batch closes is removed. A batch that needs no lookup (only
discards, retries, closes and defers) makes no listing, as today.

The input builder's own listing (`buildFilerInput` in
`tools/scheduler/src/filer/input.ts`) is not shared with apply: the model
runs between the two, often for minutes, and the merge-target check exists
to catch a target that closed in the meantime. A run therefore makes at
most two listings (one building the input, one applying the result) instead
of one plus one per `file`, `escalate`, `rewrite` and `merge_into` decision
plus one for the capability issue. No ADR: the issue is an API-budget item
with one clearly right answer, and the pattern is already in the file.

## 2. Out of scope

- The GitHub client (`tools/scheduler/src/github/client.ts`): unchanged.
  `listOpenIssues` still paginates fully, asserts the GraphQL total and
  re-lists before it fails (spec 014 AC-7); `searchOpenIssuesByMarker` stays
  in the client and in spec 008 section 5's list even though `apply.ts` no
  longer calls it.
- The input builder (`buildFilerInput`): unchanged, including its one
  `listOpenIssuesByAuthor` call and the `open_issues` it sends the model.
  Sharing that listing with apply is ruled out above.
- What each decision does once its lookup is answered: the marker regex,
  the fallback from `merge_into` to `file`, the capability issue's creation
  and closing, the triage rows and the cursor (spec 008 AC-16 and AC-18,
  spec 014, spec 018, spec 019, spec 025): unchanged.
- A target closed by someone else while the batch is being applied. Today
  each decision's own listing would notice it; with the cache, a decision
  later in the same batch would not. The window is the seconds a batch
  takes to apply, the same race already exists between a listing and the
  comment that follows it, and the issue records the defect as an API-budget
  item, not a correctness bug. Accepted.
- Any other listing the scheduler makes (the shortlist, the abandoned-issue
  listing, the loop's own): unchanged.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory and the mocked GitHub client
of `tools/scheduler/test/filer.test.ts`. "A listing" is any call of
`listOpenIssuesByAuthor`, `searchOpenIssuesByMarker`, `listOpenIssuesByLabel`
or `listOpenIssues` on that mock made while `applyFilerResult` runs; the
count is the sum over those methods. The bot's login is `bot`.

- AC-1. **One listing for a batch of files.** Given an input of 20 records
  and a result deciding `file` for every one, when the result is applied,
  then exactly one listing is made, it is `listOpenIssuesByAuthor('bot')`,
  `createIssue` is called 20 times, and the 20 triage rows are as before
  this spec.
- AC-2. **One listing for a mixed batch.** Given a result holding `file`,
  `escalate`, `merge_into` (with `issue_number` of an open bot issue the
  mock returns) and `rewrite` (for an abandoned record) decisions, when it
  is applied, then exactly one listing is made and each decision's effect is
  as before this spec: the issues are created, the merge comment is posted
  on the target, the abandoned issue is closed as superseded.
- AC-3. **No lookup, no listing.** Given a result deciding only `discard`
  (and, for abandoned records, only `retry`, `close` or `defer`), when it is
  applied, then no listing is made, as today.
- AC-4. **The marker check reads the cache.** Given the mock's
  `listOpenIssuesByAuthor` returns an issue authored by `bot` whose body
  carries `<!-- panelator-finding:old-run:1 -->`, and a result deciding
  `file` for ref `1` under a new run id, when it is applied, then
  `createIssue` is not called, the triage row for ref `1` names that issue,
  and `searchOpenIssuesByMarker` is not called. Given the same issue is
  authored by someone other than `bot` (and so is not in the bot's listing),
  then the issue is created, as today.
- AC-5. **The merge-target check reads the cache.** Given a `merge_into`
  decision whose `issue_number` the mock's `listOpenIssuesByAuthor` returns,
  when it is applied, then one comment is posted on it and no issue is
  created; given an `issue_number` the listing does not return, then the
  decision is applied as `file` with the triage reason noting it (spec 008
  AC-18), and in both cases exactly one listing is made.
- AC-6. **The capability lookup reads the cache.** Given the capability
  issue of spec 014 AC-6 is among the issues the mock's
  `listOpenIssuesByAuthor` returns, and a batch whose security decision
  fails for the third time with a permission error, when it is applied, then
  the held row names that issue's number as `capability_issue`, no second
  capability issue is created, and exactly one listing is made
  (`searchOpenIssuesByMarker` is not called). The other spec 014 AC-5, AC-6
  and AC-8 behaviours (creating the issue when none is open, closing it
  when an advisory succeeds or nothing is held) are unchanged, and a batch
  that both files an issue and looks up the capability issue still makes
  exactly one listing.
- AC-7. **The cache follows the batch's creates.** Given a result whose
  first decision is `file` (the mock's `createIssue` returns 42) and whose
  second is `merge_into` with `issue_number` 42, with a listing that does not
  contain 42, when it is applied, then the second decision comments on issue
  42 rather than falling back to `file`, `createIssue` is called once, and
  exactly one listing is made.
- AC-8. **The cache follows the batch's closes.** Given a result whose first
  decision is `rewrite` for abandoned issue 7 (bot-authored and in the
  listing) and whose second is `merge_into` with `issue_number` 7, when it is
  applied, then the second decision is applied as `file` (7 is closed), and
  exactly one listing is made.
- AC-9. **A failed listing aborts as before.** Given the mock's
  `listOpenIssuesByAuthor` rejects with `issue list incomplete: got 6,
  server reports 7`, and a result of three `file` decisions, when it is
  applied, then `applyFilerResult` rejects with that error, no issue is
  created, no triage row is written, and the cursor is unchanged (spec 014
  AC-4: the cursor follows the rows applied, and none were).
- AC-10. **The landed text follows.** Given the implementation PR's diff,
  then the parenthesis of spec 008 AC-18 reads "(the scheduler searches the
  bot's open issues for the marker before creating, listing them once per
  run; spec 037)", no other line of spec 008 changes, and no text marked
  `(maintainer answer, question #<id>)` changes anywhere.

## 4. Amendments to earlier specs

- **Spec 008 AC-18**, the parenthesis after "used so a crash does not file
  it twice": "(the scheduler searches open issues for the marker before
  creating)" becomes "(the scheduler searches the bot's open issues for the
  marker before creating, listing them once per run; spec 037)". Nothing
  else in spec 008 changes; the `merge_into` sentence of AC-18 and the
  client list of section 5 already describe what remains true.

## 5. Interfaces and files

- `tools/scheduler/src/filer/apply.ts`, `applyDecisions`: a memoised,
  lazily fetched cache of the bot's open issues, beside the existing
  `capabilityIssue` memo and in the same style (for example
  `let open: IssueData[] | undefined` and
  `const openBotIssues = async () => open ??= await d.gh.listOpenIssuesByAuthor(d.botLogin)`).
  - `file()` replaces its `searchOpenIssuesByMarker` call with a scan of the
    cache using the same regex; the `author === botLogin` test may stay or
    go (every cached issue passes it).
  - The `merge_into` case finds its target in the cache.
  - `capabilityIssue()` finds the capability issue in the cache with
    `isCapabilityIssue`, instead of calling `searchOpenIssuesByMarker`.
  - After each `createIssue` in the function (the filed issue, the
    escalation, the rewrite, the capability issue) the created issue is
    pushed onto the cache as an `IssueData` with the number returned, author
    `d.botLogin`, the title, body and labels as sent, `state: 'open'`,
    `labelEvents: []` and `createdAt: d.now().toISOString()`. After each
    `closeIssue` (the rewrite's superseded issue, `closeCapability`) the
    issue is removed from the cache. Label changes (`removeLabel` on a
    retry) need not be mirrored: nothing in `apply.ts` reads cached labels.
    The push and the removal happen only when the cache has been fetched; a
    batch that creates an issue without ever needing a lookup (none exists
    today, since every create follows a lookup) would not fetch one.
  - Nothing else in the function changes: validation, the triage rows, the
    copies of spec 019, the cursor, the notifications and the logs are as
    they are.
- `tools/scheduler/src/filer/input.ts`, `tools/scheduler/src/github/client.ts`:
  unchanged.
- `tools/scheduler/test/filer.test.ts`: tests for AC-1 to AC-9. The existing
  tests that seed `searchOpenIssuesByMarker` (the marker test "uses stable
  source markers after a crash", and the capability tests that return
  `capIssue`) move their fixtures onto `listOpenIssuesByAuthor`, since
  `apply.ts` no longer calls `searchOpenIssuesByMarker`; the fixtures that
  seed `listOpenIssuesByAuthor` for `merge_into` stay. The mock gains no new
  method. The count of listings in an AC is asserted over the four mocked
  listing methods named in section 3.
- `tools/scheduler/test/filer-results.test.ts`: unchanged unless its mock
  needs the same fixture move; it seeds neither method today.
- `specs/008-agent-registry/spec.md` AC-18: the amendment of section 4
  (AC-10).

The spec PR itself adds
`specs/037-filer-apply-lists-open-issues-once/spec.md` and lists this spec
under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The
change touches no gate, bound, label rule or permission. The one property
worth the reviewer's glance is kept: the marker check accepts only issues
the App authored, because the cache is the bot's own listing (and the
regex's `author` test, if kept, is redundant rather than removed), so a
body written by anyone else cannot claim a ref's marker, as today.

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test fails on `main` (20 `searchOpenIssuesByMarker` calls) and
  passes after the change; the AC-3 test passes before and after (it pins
  the zero-listing batch). The AC-7 test fails on `main` (the second
  decision falls back to `file`) and passes after.
- `grep -n "searchOpenIssuesByMarker" tools/scheduler/src/filer/apply.ts`
  finds nothing; `grep -c "listOpenIssuesByAuthor" tools/scheduler/src/filer/apply.ts`
  prints 1.
- `git diff main -- specs/008-agent-registry/spec.md` shows only the one
  amended parenthesis of section 4 (AC-10).
- Live check after deploy: the service log for a filer run with several
  `file` decisions shows one issue listing (one REST pagination and one
  GraphQL count) during apply, and none of the `issue list incomplete`
  re-list waits of spec 014 AC-7 between consecutive `createIssue` calls.

## 7. Open decisions

None.
