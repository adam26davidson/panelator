# 078. The children scan completes a blocked comment it failed to post, and files a design's children in dependency order

Status: written 2026-11-18 from the delivery-system design for issue #146;
specs derived from that design need no maintainer approval (design section 11).
Amends [031-design-files-children](../031-design-files-children/spec.md) AC-4
(the filing order), AC-5 (a blocked comment that failed after the issue was
filed) and AC-6 (a `blocked` with no blocked marker comment); each is marked
as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a top
design; "Enforced in code") and section 4 (agents resolve every blocker that
is not a section 3 question);
[031-design-files-children](../031-design-files-children/spec.md) AC-4 to
AC-7 (the scan, its markers, the `blocked` label it adds and removes, and the
rule that it never removes a `blocked` it did not add);
[066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md)
AC-5 (the filer's same repair: a crash between its create and its comment
leaves `blocked` without what it waits for, and the filer posts the missing
comment); [039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the marks this PR writes).

## 1. Goal

Two reconciliations between spec 031 and the merged children scan
(`tools/scheduler/src/children/scan.ts`), found by issue #41's review of
PR #135.

**A failed blocked comment leaves `blocked` for ever.** When `createIssue`
succeeds for a planned child whose `after:` sibling is not done, the issue is
created with `blocked` and the scan then posts the blocked marker comment
(spec 031 AC-5). If that comment call fails (a rate limit, the network, a
restart between the two calls), the scan logs `child-filing-failed` and goes
on. Every later scan finds the child's issue by its marker and files nothing
(AC-4), and the unblock pass skips the issue because it has no App-authored
blocked marker comment (AC-6 treats that as a hand-set label). So the issue
keeps `blocked` for ever, although the scan set it, and the work it carries is
never shortlisted. Spec 031 says what happens when `createIssue` fails and
says nothing about the comment.

After this spec, the scan completes its own work: given the child's issue is
the scan's (App-authored, carrying the child marker) and the `blocked` on it
was put there by the App, the scan posts the missing blocked comment, and
AC-6 then applies as for any issue the scan blocked. A `blocked` put there by
anyone else is still never touched.

**The filing order.** Spec 031 AC-4 says children are filed "in file order
then bullet order". The scan files each design's planned children in
dependency order (`inDependencyOrder`: a sibling named by `after:` first), so
that AC-5's `After: #<n>` line and blocked comment name a filed issue rather
than a slug. The issues filed are the same; the order is not what AC-4 says.
The dependency order is the right one and AC-4 is brought in line with it.

## 2. Out of scope

- A failed `createIssue`, its retry and its failure counter (spec 031 AC-4):
  unchanged.
- The filer's own blocks (spec 066) and `liftFilerBlocks`: unchanged.
- A `blocked` on an issue the scan did not file (an `issue: #<n>` recorded by
  hand on an issue without the App's child marker, such as #37) or on the
  scan's issue but added by another account: never commented on, never
  removed, as spec 031 AC-6 says.
- The marker formats, the comment texts of AC-5 and AC-6 and the neutralising
  of spec 076: unchanged.
- The order in which designs are visited (the order of `loadDesignTree`):
  unchanged.

## 3. Acceptance criteria

- AC-1. Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-6: the repair skips an issue whose latest blocked-by marker is set, so it never posts a child-blocked comment over a wait. **The scan posts a blocked comment it failed to post.** On every
  scan, in the pass that judges unblocking (spec 031 AC-6), for every planned
  child whose issue (resolved as AC-4 and AC-7 say) is open, carries
  `blocked`, was not filed by this same scan, and is the scan's own issue
  (`isChildIssue`: authored by the App bot login and carrying
  `<!-- panelator-child:<design path>:<slug> -->`, whether it was found by
  the marker or recorded by `issue:`), and that has neither a blocked marker
  comment nor an unblocked marker comment by the App bot login: the scan
  reads the issue's label timeline, and given the latest `labeled` event for
  `blocked` (the event that put the current label on, `latestLabelActor` in
  `gates/authority.ts`) has the App bot login as its actor, then:
  1. it posts the blocked comment of spec 031 AC-5, with the same text and
     marker, naming the `after:` siblings that are not done now; when every
     sibling is done now it names every `after:` sibling, and when the entry
     has no `after:` any more it says `its siblings` in their place (as the
     unblocked comment already does);
  2. it logs `{ kind: "child-blocked-comment-posted", design, slug, issue }`;
  3. in the same pass it judges the issue as spec 031 AC-6 says, with the
     comment just posted counting as the blocked marker comment: given every
     `after:` sibling is done, then it removes `blocked` and posts the
     unblocked comment; given one is not, the issue waits for a later scan.

  Given the comment call fails, then the scan logs
  `{ kind: "child-filing-failed", design, slug, error: "blocked comment: <message>" }`
  and adds an entry to its `errors`, as for the comment after `createIssue`,
  and the next scan tries again. This failure does not count toward the
  three-scan counter of spec 031 AC-4 *(agent's call: the issue exists and
  carries its label, so nothing is lost; the counter is for a child with no
  issue at all)*. The timeline is read only for an issue that meets every
  other condition above, so a scan where no comment went missing makes no
  more GitHub calls than today.
- AC-2. **A `blocked` the scan did not put on stays untouched.** Given an
  open child issue with `blocked` and no blocked or unblocked marker comment
  by the App bot login, when either the issue is not the scan's own
  (not App-authored, or without the child marker: a hand-filed issue recorded
  by `issue:`, as #37), or the latest `labeled` event for `blocked` has an
  actor other than the App bot login (a person blocked the scan's issue by
  hand, including after the scan's own label was removed and put back), or
  the timeline has no `labeled` event for `blocked`, then the scan posts no
  comment, never removes the label, and logs nothing for it. Spec 031 AC-6's
  rule that a hand-set `blocked` is never removed holds as before.
- AC-3. **A design's planned children are filed in dependency order.** Given
  a scan, then it visits the designs in the order of `loadDesignTree`, and
  within a design it files the planned children in dependency order: a
  planned child after every planned sibling its `after:` names, and in bullet
  order otherwise (`inDependencyOrder`). File siblings named by `after:` are
  not filed by the scan and do not affect the order. Given a design whose
  bullet order lists `b` (with `after: a`) before `a`, and neither has an
  issue, then `a` is filed first and `b`'s body carries `After: #<a's issue>`
  and its blocked comment names `#<a's issue>`, never the slug `a`. Given a
  cycle among `after:` references (which the design-tree check of spec 031
  AC-2 rejects, so it cannot reach `main` through a reviewed PR), then the
  remaining children of the cycle are filed in bullet order and the scan does
  not stop.
- AC-4. **Everything else is unchanged.** Given every child issue that
  carries `blocked` also has its blocked marker comment (every scan whose
  comment calls succeeded), then the scan files, blocks and unblocks exactly
  as before this spec; every existing case of `children.test.ts` passes
  unchanged except where it must give the fake client a label timeline.
  `tools/README.md` names the new log kind and the repair in its paragraph on
  the scan.

## 4. Amendments to earlier specs

This PR prepends a mark to each unit below (spec 039); the earlier text
follows unchanged. A unit that already carries a mark keeps it after the new
one.

- [031-design-files-children](../031-design-files-children/spec.md) AC-4:
  `Amended by [078-children-scan-repairs-blocked-comment](../078-children-scan-repairs-blocked-comment/spec.md) AC-3: within a design, planned children are filed in dependency order (after the planned siblings their after: names), bullet order otherwise.`
- [031-design-files-children](../031-design-files-children/spec.md) AC-5:
  `Amended by [078-children-scan-repairs-blocked-comment](../078-children-scan-repairs-blocked-comment/spec.md) AC-1: given the blocked comment failed after the issue was filed with the App's blocked label, a later scan posts it.`
- [031-design-files-children](../031-design-files-children/spec.md) AC-6:
  `Amended by [078-children-scan-repairs-blocked-comment](../078-children-scan-repairs-blocked-comment/spec.md) AC-1: a blocked the App put on the scan's own issue without its marker comment gets that comment first and is then judged here; any other blocked without the marker comment is still never removed.`

## 5. Interfaces and files

This list is the implementation's file scope.

- `tools/scheduler/src/children/scan.ts`: `ChildrenGh` gains
  `labelEvents(issue: number): Promise<LabelEvent[]>` (the GitHub client
  already has it); the unblock pass gains AC-1's repair before its AC-6
  judgement; the comment text of AC-5 is built by one function used by both
  the filing and the repair; `inDependencyOrder`'s doc comment names spec 078
  AC-3. The listing stays `labelEvents: false`.
- `tools/scheduler/test/children.test.ts`: the fake client records a
  `labeled` event by its author for each label given to `createIssue` and to
  `addLabels`, can be told to fail `comment`, and answers `labelEvents`; the
  cases of section 6.
- `tools/README.md`: the scan paragraph (AC-4).
- `dev-logs/` as a directory for the implementation's log.

`tools/scheduler/` is a sensitive path, so the security review runs on the
implementation PR. No configuration, schema or state file changes.

## 6. Verification

- `tools/scheduler/test/children.test.ts`:
  - AC-1, the issue's case: a design with planned `one` and `two`
    (`after: one`). Scan 1 with `comment` failing: both issues filed, `two`
    carries `blocked` and has no comment, `child-filing-failed` logged with
    `blocked comment:`. Scan 2 with `comment` working and `one` still open:
    `two` gets exactly one blocked comment with the blocked marker naming
    `#<one>`, `child-blocked-comment-posted` logged, `blocked` kept. Scan 3
    after `one` is closed: `blocked` removed and the unblocked comment posted
    once. Scan 4: nothing changes.
  - AC-1, sibling already done: as above, but `one` is closed before scan 2:
    scan 2 posts the blocked comment and, in the same scan, removes `blocked`
    and posts the unblocked comment.
  - AC-1, the comment failing again on scan 2: logged, in `errors`, nothing
    appended to the findings queue, and scan 3 posts it.
  - AC-2: a child filed with no `after:` that a person then labels `blocked`
    (event actor the maintainer): no comment, label kept over two scans with
    every sibling done; the scan's own blocked label removed by hand and
    added back by a person: the same; a hand-filed issue recorded by
    `issue:` with `blocked` and no marker comment: the same; and a scan
    that hits no repair candidate calls `labelEvents` zero times.
  - AC-3: a design listing `b` (`after: a`) before `a`: `a` is created first,
    `b`'s body has `After: #<a>`, and its blocked comment names `#<a>`.
- The spec-scope gate and the design-tree check pass on this PR: the marks of
  section 4 and the parent's `## Children` entry.
- After the merge, the implementer reads the label timeline of one real issue
  the scan filed with `blocked` (or, if none exists, one the filer filed with
  `blocked` through the same App) and records in the dev log that it shows a
  `labeled` event for `blocked` whose actor is the App bot login, which AC-1
  relies on.
- `pnpm test` from the repo root passes.

## 7. Open decisions

None.
