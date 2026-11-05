# 032. Spec 008's interface list names the draft-advisory lookup

Status: written 2026-11-05 from the delivery-system design for issue #54;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 6.2 (a reviewed PR for every change to repository
content); [008-agent-registry](../008-agent-registry/spec.md) AC-22 (the
draft advisory, and its retry after a failed call) and section 5 (the GitHub
client list); [021-stale-spec-text-after-008](../021-stale-spec-text-after-008/spec.md)
(the convention this spec follows: a landed spec's text is corrected by a
small tooling spec whose implementation PR edits the landed text). Corrects
the one defect of issue #54 that is still on `main`.

## 1. Goal

An agent that reads spec 008 section 5 for the GitHub calls the scheduler
makes on the filer's behalf reads what shipped.

### What is wrong today

Issue #54 names two defects in spec 008 section 5. The first, the file-scope
sentence that contradicted the file list above it, was corrected by spec 021
(AC-3, PR #86): the sentence on `main` now reads "No file outside
`tools/scheduler/`, `agents/`, `schemas/scheduler/` and `dev-logs/` is
changed except `tools/README.md`, listed above." Nothing remains to do for
it.

The second is still on `main`. Section 5's entry for
`tools/scheduler/src/github/client.ts` lists the calls the client makes and
ends with "create a draft repository security advisory". The filer's advisory
path (spec 008 AC-22) makes one more call on the same resource: before it
creates an advisory it lists the repository's draft security advisories and
looks for one whose description carries the record's private marker
(`findDraftSecurityAdvisory` in `tools/scheduler/src/github/client.ts`,
called from `tools/scheduler/src/filer/apply.ts` as
`findDraftSecurityAdvisory(marker) ?? createDraftSecurityAdvisory(...)`).
That lookup is what keeps a retried advisory (AC-22's "security, advisory
failed" path) from being created twice. It is a read on the resource the App
already holds "repository security advisories (write)" for (spec 001 section
12), so no new grant is involved, but the list is incomplete.

### The fix

One text correction, nothing else: the `client.ts` entry of spec 008 section
5 names the lookup beside the creation, with its purpose.

## 2. Out of scope

- The lookup itself, the advisory path, `tools/scheduler/src/filer/apply.ts`,
  `tools/scheduler/src/github/client.ts` and their tests: all unchanged. This
  spec records what shipped; it ships nothing new.
- Spec 008 AC-22 and the rest of spec 008: unchanged. AC-22 already requires
  the retry; how the implementation makes the retry idempotent is an
  interface detail, and section 5 is where interfaces are listed.
- The file-scope sentence of spec 008 section 5 (issue #54 point 1): already
  corrected by spec 021 and not touched again.
- The App's permission set (spec 001 section 12) and the capability issue the
  filer opens when the App cannot create advisories: unchanged. The lookup
  needs no permission the App does not already hold.
- Any other passage of any spec that its implementation outgrew. The issue
  names this one; a sweep of the others is a finding for the filer, not this
  spec.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the PR branch, read as text; "then" clauses
are checked by reading them and by `pnpm test` where it says so.

- AC-1. **Spec 008's client entry names the lookup.** Given
  `specs/008-agent-registry/spec.md` section 5, when an agent reads the entry
  for `tools/scheduler/src/github/client.ts`, then that entry names, beside
  "create a draft repository security advisory", a call that lists the
  repository's draft security advisories and finds the one whose description
  carries a given marker, and says it runs before the creation so that a
  retried advisory (AC-22) is not created twice. The entry still names every
  call it names on `main` today.
- AC-2. **Nothing else in spec 008 changes.** Given the implementation PR's
  diff of `specs/008-agent-registry/spec.md`, then it touches only the
  `client.ts` entry of section 5: every other line of the file is as it is on
  `main`, and the text of AC-22 and of the file-scope sentence is unchanged.
- AC-3. **No maintainer decision and no enforcement changes.** Given the
  implementation PR's diff, then it changes no text marked `(maintainer
  answer, question #<id>)`, nothing under `docs/`, `tools/`, `agents/`,
  `.github/` or `schemas/`, and no gate, bound or label rule of specs 001 and
  006 (security criterion 5). The change describes a call the merged
  implementation already makes under a permission it already holds.
- AC-4. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and
  the design-tree check still accept spec 008 and this spec.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly one
file:

- `specs/008-agent-registry/spec.md`: the `tools/scheduler/src/github/client.ts`
  entry of section 5 gains the draft-advisory lookup (AC-1).

The spec PR itself adds `specs/032-spec-008-lists-advisory-lookup/spec.md`
and lists it under `## Children` in `docs/delivery-system-design.md`.

`specs/008-agent-registry/spec.md` is not a sensitive path, so the ordinary
review applies to the implementation PR. Nothing here changes the
sensitive-path list, the security criteria, or what routes a sensitive diff
to the security review.

Suggested wording for the entry (the implementer may tighten it, keeping
AC-1's content); the changed clause is the last one:

> - `tools/scheduler/src/github/client.ts`: create an issue with labels, list
>   open issues by label and by author (full pagination, process-spec 6.4),
>   search open issues for a body marker, close an issue with a comment, remove
>   a label, list check runs for a SHA, re-run and cancel a workflow run,
>   list the repository's draft security advisories and find the one whose
>   description carries a marker (run before the creation so a retried
>   advisory, AC-22, is not created twice), create a draft repository security
>   advisory.

## 5. Verification

- `pnpm test` from the repository root passes (AC-4).
- `git diff main -- specs/008-agent-registry/spec.md` shows changes inside
  the `client.ts` entry of section 5 only (AC-1, AC-2).
- `git diff main --stat` lists no file other than that one (AC-3).
- Reading check: after the change,
  `grep -n -i "draft security advisories" specs/008-agent-registry/spec.md`
  finds the lookup in section 5, and
  `grep -n "No file outside" specs/008-agent-registry/spec.md` still finds
  the sentence spec 021 corrected, unchanged.

## 6. Open decisions

None.
