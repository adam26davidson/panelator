# 076. One marker neutraliser for every text the scheduler writes to GitHub

Status: written 2026-11-18 from the delivery-system design for issue #144;
specs derived from that design need no maintainer approval (design section 11).
Amends [014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) AC-6
(the filer defuses only the capability family),
[031-design-files-children](../031-design-files-children/spec.md) AC-4 (the scan
neutralises only the child family, and only in the brief),
[066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-5
(the filer neutralises only the block family), and
[028-reflection-agents](../028-reflection-agents/spec.md) AC-6 and AC-7 (the
reflection's plan issue, comments and item issues, which neutralise nothing).
Each is marked as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a top
design) and section 4 (agents resolve every blocker that is not a section 3
question); [014-filer-batch-integrity](../014-filer-batch-integrity/spec.md)
AC-6 (model-written text cannot carry the capability marker);
[031-design-files-children](../031-design-files-children/spec.md) AC-4 (the
child marker is the scan's idempotency key; only the App's issue counts);
[066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-5
(model text cannot forge a block marker);
[008-agent-registry](../008-agent-registry/spec.md) AC-18 (the finding marker
is the filer's idempotency key); [028-reflection-agents](../028-reflection-agents/spec.md)
AC-6 and AC-7 (the reflection markers);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the marks this PR writes).

## 1. Goal

The scheduler recognises its own records on GitHub by a hidden HTML-comment
marker (`<!-- panelator-<family>:... -->`) in a body or comment the App
authored. Text the scheduler did not write itself (a model's finding, a design
brief, a question, a review reason, a maintainer's answer) must never carry a
working marker of any family into an App-authored body or comment, whichever
writer posts it. After this spec, one function neutralises every
`panelator-` marker, every writer applies it to all the text it posts except
its own marker, and every marker lookup matches the whole marker on text the
App authored.

### What is wrong today

Each writer neutralises only its own family, with its own one-line function:

- `neutraliseChildMarkers` (`tools/scheduler/src/children/markers.ts`)
  rewrites comments beginning `panelator-child`, applied by the children scan
  to the brief and the title only;
- `stripCapabilityMarkers` (`tools/scheduler/src/filer/input.ts`) rewrites
  `panelator-capability`, and `neutraliseBlockMarkers`
  (`tools/scheduler/src/filer/blocked.ts`) rewrites `panelator-blocked` and
  `panelator-unblocked`; the filer's `strip` in
  `tools/scheduler/src/filer/apply.ts` applies these two and nothing else.

So a finding whose text quotes `<!-- panelator-child:<design>:<slug> -->` for
a real planned child is filed by the filer as an App-authored issue carrying
that marker; the next children scan takes it as the child's record
(`isChildIssue`: author plus marker) and never files the child, and
`liftFilerBlocks` skips it as a planned child. A design brief that quotes
`<!-- panelator-finding:<run>:<ref> -->` gives an App-authored child issue that
the filer's existing-issue lookup for that ref adopts, so the finding is never
filed. The filer does not neutralise its own finding family either, nor the
`panelator-security-finding` marker in a model-written advisory description,
which `findDraftSecurityAdvisory` searches for.

Writers outside these two neutralise nothing: the chain's question comment
(model-written question, options and recommendation, ending with the
`panelator-question` marker that recovery adopts), the reminder comment that
repeats the question, the chain's issue comments, closing comments and PR
closing comments (which carry review and failure reasons), the children scan's
blocked comment (which repeats the design's `after:` text) and the Telegram
answer comment (the maintainer's text, quoted). Spec 028's reflection, not yet
built, specifies plan and item issues whose bodies are model text and
neutralises nothing.

Two further gaps make the per-family functions insufficient even for their own
family:

- They rewrite in one pass, so the output can carry a marker the input did not:
  `<!-- panelator-child-panelator-child:docs/designs/x.md:a -->` becomes
  `<!-- panelator-child:docs/designs/x.md:a -->` (checked with the current
  regex). The same holds for the capability and block functions.
- The filer's `merge_into` guard (`apply.ts`, "comment not posted twice")
  accepts any comment, by any account, whose body contains `:<ref> -->`. A
  neutralised marker of any family that ends in the same ref still matches
  it, and so does a human's comment, so the record is never appended.

Inputs reach these bodies only through reviewed designs or finding records
written by stage agents, so the exposure is low; this is hardening (the issue,
from the security review of PR #135).

## 2. Out of scope

- What a stage agent posts on GitHub itself with `gh` under the App token (a
  PR body, a comment it writes). The scheduler's writers are the subject; no
  lookup reads PRs as issues (the client drops `pull_request` rows).
- Comments by other accounts carrying the `panelator-capability-closed`
  marker, which the two capability-closing guards (`filer/apply.ts`,
  `service/loop.ts`) accept from any author. That is not App-authored text and
  is reported as a finding, not changed here.
- The marker formats themselves, which marker each writer appends, and every
  lookup's other conditions (the capability issue's fixed title, `issue:`
  winning over the child marker, the question nonce). Unchanged.
- Fixed text the scheduler composes from nothing but its own strings and
  numbers (the capability issue body, `blockedByComment`, `unblockedComment`,
  the capability closing comment). It may pass through the neutraliser, where
  it is unchanged, but need not.
- Building spec 028's reflection. This spec only adds the neutralising rule to
  its text (AC-6) so whoever builds it applies it.

## 3. Acceptance criteria

- AC-1. **One neutraliser, to a fixed point.** Given any string, then
  `neutraliseMarkers` in `tools/scheduler/src/github/markers.ts` returns a
  string with no match of `<!--\s*panelator-` (any case, any whitespace
  including none and newlines between `<!--` and `panelator-`). It rewrites
  each match to `<!-- ` and repeats until no match is left, so a rewrite never
  leaves a marker behind: given
  `<!-- panelator-child-panelator-child:docs/designs/x.md:a -->`,
  `<!--panelator-panelator-finding:r:3 -->` or
  `<!-- PANELATOR-\npanelator-capability:security-advisories -->`, then the
  output contains no `<!-- panelator-`. Given text without a match, then it is
  returned unchanged. A neutralised marker stays an HTML comment, so it stays
  hidden as before. `neutraliseChildMarkers`, `stripCapabilityMarkers` and
  `neutraliseBlockMarkers` are removed and every caller uses
  `neutraliseMarkers`; the module's doc comment states the rule of AC-2 for
  any future writer.
- AC-2. **Every writer neutralises everything but its own marker.** Given a
  writer below posting text that contains a marker of every family the
  scheduler uses (`panelator-finding`, `panelator-security-finding`,
  `panelator-capability`, `panelator-capability-closed`, `panelator-child`,
  `panelator-child-blocked`, `panelator-child-unblocked`,
  `panelator-blocked-by`, `panelator-unblocked-by`, `panelator-blocked-until`,
  `panelator-question`, `panelator-telegram-answer`, `panelator-reflection`),
  then what reaches GitHub has no match of `<!--\s*panelator-` except the
  writer's own marker, appended after the neutralised text (none for a writer
  without one). The writers:
  1. the findings filer (`filer/apply.ts`): a filed issue's title and body
     (with the `Filer verification:` reason), the `merge_into` comment, the
     `retry` comment, the `rewrite` and `close` closing comments, the
     `blocked_until` condition, and a security advisory's title and
     description (its own marker `panelator-security-finding` appended after);
  2. the children scan (`children/scan.ts`): the child issue's title and body
     (the brief and the scan's sentences, the child marker appended after),
     and the blocked and unblocked comments (the sibling labels, the `after:`
     text and the design path, their markers appended after);
  3. the chain driver (`chain/driver.ts`): the `comment` action's text (with
     the run record list of an abandoned issue), the `close_issue` comment and
     the `close_pr` comment, none of which carries a marker of its own;
  4. the question comment (`formatQuestion` in `chain/question.ts`): the
     question body (question, request fields, options, recommendation), the
     `panelator-question` marker appended after; and the reminder comment
     (`service/loop.ts`, "Still waiting on your answer"), which has none;
  5. the Telegram answer comment (`telegram/answers.ts`): the quoted answer,
     the `panelator-telegram-answer` marker appended after. The answer the
     resumed stage receives (`answer` on the paused record) is the
     maintainer's text unchanged; only the comment is neutralised.
- AC-3. **A finding cannot take a planned child's place, nor a brief a
  finding's.** Given a `file` decision whose body quotes
  `<!-- panelator-child:docs/designs/x.md:a -->` for a planned child `a` of
  `docs/designs/x.md` with no issue, then after the filer files it the next
  children scan files the child's own issue (the filer's issue is not the
  child's record), and `liftFilerBlocks` still treats the filer's issue as
  the filer's. Given a planned child whose brief quotes
  `<!-- panelator-finding:r1:7 -->`, then after the scan files it the filer's
  existing-issue lookup for ref `7` finds nothing and a `file` decision for
  ref `7` creates its issue.
- AC-4. **The merge guard matches the whole marker on the App's comment.**
  Given a `merge_into` decision for ref `12` whose target issue has a comment
  containing `:12 -->` that is not the App's comment carrying
  `<!-- panelator-finding:<run id>:12 -->` (a human's comment with the full
  marker, or an App comment with a neutralised `<!-- child:d:12 -->`), then
  the record is appended as a comment. Given the target already has an App
  comment carrying `<!-- panelator-finding:<any run id>:12 -->` (a retry after
  a crash), then nothing is posted, as today. The guard uses the same pattern
  as the existing-issue lookup (spec 008 AC-18): the whole marker, with the
  ref escaped, on text by the App bot login.
- AC-5. **The reflection follows the same rule.** Spec 028 AC-6 and AC-7 are
  marked (section 4): every model-written text the reflection posts (the plan
  issue's body other than its marker, the `existing_issue` comment, the
  closing comment, an item issue's title and body) passes through
  `neutraliseMarkers` before its own `panelator-reflection` marker is
  appended. This spec builds nothing for the reflection; the test of AC-2
  gains its row when spec 028 is built.

## 4. Amendments to earlier specs

This PR prepends a mark to each unit below (spec 039); the earlier text
follows unchanged.

- [014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) AC-6:
  `Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-2: text the filer model wrote has every panelator- marker of any family neutralised, not only the capability prefix.`
- [031-design-files-children](../031-design-files-children/spec.md) AC-4:
  `Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-2: the brief, the title and the blocked and unblocked comments have every panelator- marker of any family neutralised, not only the child prefix.`
- [066-filer-files-blocked-issues](../066-filer-files-blocked-issues/spec.md) AC-5:
  `Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-2: the text is neutralised for every panelator- marker of any family, to a fixed point, not only the block prefixes.`
- [028-reflection-agents](../028-reflection-agents/spec.md) AC-6:
  `Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-5: model-written text in the plan issue and its comments passes through neutraliseMarkers before the reflection marker is appended.`
- [028-reflection-agents](../028-reflection-agents/spec.md) AC-7:
  `Amended by [076-one-marker-neutraliser](../076-one-marker-neutraliser/spec.md) AC-5: an item issue's model-written title and body pass through neutraliseMarkers before the reflection marker is appended.`

## 5. Interfaces and files

- `tools/scheduler/src/github/markers.ts` (new): `neutraliseMarkers(text:
  string): string` (AC-1), with a doc comment stating AC-2's rule.
- `tools/scheduler/src/children/markers.ts`: `neutraliseChildMarkers`
  removed; `children/scan.ts` neutralises the title, the brief and the free
  text of the blocked and unblocked comments with `neutraliseMarkers`.
- `tools/scheduler/src/filer/input.ts`: `stripCapabilityMarkers` removed.
  `tools/scheduler/src/filer/blocked.ts`: `neutraliseBlockMarkers` removed.
  `tools/scheduler/src/filer/apply.ts`: `strip` is `neutraliseMarkers` after
  the `Spec:` line removal it already has where it has it; the advisory title
  and description are neutralised; the `merge_into` guard is AC-4's.
- `tools/scheduler/src/chain/question.ts`: `formatQuestion` neutralises the
  body before appending the marker. `tools/scheduler/src/chain/driver.ts`: the
  `comment`, `close_issue` and `close_pr` texts are neutralised.
  `tools/scheduler/src/service/loop.ts`: the reminder comment is neutralised.
  `tools/scheduler/src/telegram/answers.ts`: the quoted answer is neutralised.
- Tests: `tools/scheduler/test/markers.test.ts` (new) for AC-1 and the
  writer table of AC-2; additions to `filer.test.ts` and `children.test.ts`
  for AC-2, AC-3 and AC-4. Existing tests that assert the per-family
  functions' output keep their assertions on what reaches GitHub (no working
  marker of the family), which still hold.
- `tools/scheduler/` is a sensitive path, so the security review runs on the
  implementation PR. No configuration, schema or state file changes.

## 6. Verification

- `tools/scheduler/test/markers.test.ts`: AC-1 with the three recombining
  inputs, mixed case, no space, several spaces and a newline after `<!--`,
  and an input without markers returned unchanged. AC-2 as a table, one row
  per writer of AC-2 items 1 to 5, each fed a text carrying one marker of
  every family listed there (the family list is one constant in the test, so
  a new family is one line), asserting that the text posted through the fake
  GitHub client has exactly the writer's own marker (or none) as its only
  match of `<!--\s*panelator-`.
- `tools/scheduler/test/filer.test.ts` and `children.test.ts`: AC-3's two
  cross-writer cases end to end against the fake client (the filer files,
  then the scan runs; the scan files, then the filer runs), and AC-4's three
  `merge_into` cases (human comment, neutralised App comment, real App
  marker).
- The spec-scope gate and the design-tree check pass on this PR: the marks of
  section 4 and the parent's `## Children` entry.
- `pnpm test` from the repo root passes.

## 7. Open decisions

None.
