# 2026-11-05: a merged design files issues for its children (issue #41, spec 031)

## What was built

- **The form.** `parseChildEntries` (`tools/scheduler/src/spec/parse.ts`) reads both kinds of bullet of a
  design's `## Children` section: file children, and `- planned: <slug>` with indented `title:`, `brief:`,
  `after:`, `class:` and `issue:` lines. `parseChildren` still returns only the file children's paths, so the
  spec-present and scope gates did not change. `checkDesignTree` validates planned children (AC-2) and
  `designTreeReport` is the seam for spec 028's `design_tree` input.
- **The scan.** `fileDesignChildren` (`tools/scheduler/src/children/scan.ts`) runs on the service's first tick
  and on every tick where `fastForward` reports that `origin/main` moved, after the fast-forward and before the
  shortlist. It lists all issues once (`listIssues({ state: "all", labelEvents: false })`: no timeline call per
  issue), files one App-authored `validated` issue per planned child with no issue, and blocks and unblocks by
  `after:`.
- **Markers** (`children/markers.ts`): `<!-- panelator-child:<design>:<slug> -->` in the issue body;
  `<!-- panelator-child-blocked:... -->` and `<!-- panelator-child-unblocked:... -->` in the scan's comments.
  Only issues and comments authored by the App bot login count; a hand-set `blocked` is never removed.
- **State.** `children/failures.json` in the state directory counts consecutive scans on which an issue could
  not be filed; the third appends one finding (`stage: children-scan`) and resets the count.
- **The split row** (AC-9). When a spec-track merge leaves spec-present failing and the spec directory holds a
  `README.md` and the merged diff added a design with at least two children, the chain comments, closes the
  issue, removes the claim label and ends `done`, with a `debt`/`system` record in `merges.jsonl`. The
  spec PR's scope gate takes the parent from the sub-design when `spec.md` does not exist (`splitParent` in
  `chain/driver.ts`); without that a split PR failed the scope gate with "no Parent line".
- **Stage text.** `agents/stages/spec.md`, `agents/profiles/spec/instructions.md` and review criterion 8.
- **The migration.** `docs/delivery-system-design.md` section 11's table became a paragraph (marked
  *(author's call)*); the `## Children` bullets carry row letters and issue numbers; `console` (#101) and
  `test-board` (#132) are planned children with `issue:`.

## Decisions of the implementation

- `IssueData.state` is optional in the type (the client always sets it), so gate and shortlist test helpers
  outside this change's file scope still typecheck.
- `listIssues` takes an optional `labelEvents: false`; listing every closed issue would otherwise cost one
  timeline request each.
- Within a design, planned children are filed in dependency order (a sibling named by `after:` first), so the
  `After: #n` line and the blocked comment can name the issue the same scan filed.
- The end-to-end run for AC-9 calls `fileDesignChildren` directly after the fast-forward instead of a second
  tick, because a second tick would claim the freshly filed child with no scripted stages; the loop's own
  triggering is covered by `loop.test.ts` and by the first end-to-end run.

## What to check in the service log after the merge

On the first tick after the service restarts on the merged `main`:

- there is **no** `child-filed` entry for `docs/delivery-system-design.md`: both planned children carry
  `issue:` (#101, #132), so nothing is filed;
- no `child-unblocked` entry (#101 has no blocked marker comment);
- no `children-scan-failed` entry;
- a `child-issue-dead` entry means a recorded issue number is closed `abandoned` or missing: fix the bullet
  through a reviewed PR.
