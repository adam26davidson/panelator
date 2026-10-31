# 0004. Spec 012 is split into a sub-design with three child specs

Status: accepted
Date: 2026-10-31
Amends: [specs/012-metrics-reflection](../../specs/012-metrics-reflection/README.md)
(now a pointer) and row D of the
[delivery-system design](../delivery-system-design.md) section 11
Decided by: the maintainer approved splitting the spec, as reported to the
session that wrote this by the coordinating session on 2026-10-31; the shape of
the split is the agents' call; carried by
[docs/designs/metrics-reflection.md](../designs/metrics-reflection.md)

## Context

Issue #15 (event store, metrics and three reflection agents) went through one
chain and failed five times: PRs #34, #43, #64, #72 and #77, about $95 over 73
runs. The last closed PR changed 73 files and about 3,400 lines.

The failures were not one defect. Each review round found real, distinct
findings, and the findings filer's own retry note on #15 records that the count
was converging when the bounds ended the attempt. Scope-gate failures, fix
cycles and rebases all drew on a single issue's rescue, re-plan and spec-revision
bounds, and those bounds are chain configuration sized for one change of ordinary
size (design section 4). A larger bound would have spent more on a diff that
keeps offering a reviewer new surface.

Options considered:

1. **Raise the bounds for this issue.** It keeps every failure mode, costs more
   per attempt, and makes bounds something a large issue can argue with.
2. **Two issues**, event store plus metrics, then the reflection agents, as the
   filer's note on #15 suggested. The first would still be about 2,000 lines, and
   most recording and report review findings would land in one PR.
3. **Three specs under a sub-design** (chosen). The store, the metrics and the
   agents have narrow contracts between them and merge in that order, and each
   leaves `main` working.

## Decision

- `docs/designs/metrics-reflection.md` is a design under the delivery-system
  design, holding the maintainer's decisions verbatim, the contracts between its
  children and the map from each criterion of spec 012 to its new home.
- Its children are spec 026 (event store and recording), spec 027 (metrics) and
  spec 028 (reflection agents and plans as issues), built in that order, each
  with its own issue, chain and bounds.
- No acceptance criterion is dropped. The open gaps in spec 012 (#69, #71, #79,
  #82) are settled in the child each belongs to, so those issues need no spec
  work of their own.
- Each child's interfaces section gives full paths and the directory prefixes the
  plan should use. The scope gate requires a sensitive file to be listed in the
  spec, and a shortened `src/...` path does not match.
- `specs/012-metrics-reflection/` keeps a `README.md` pointer and no `spec.md`.
  The design-tree check and the spec gates read only `spec.md`, so the number
  stays taken and nothing treats it as a spec.

## Consequences

- Issue #15 is replaced by three issues. Its `Spec:` line names a file that no
  longer exists, so the spec-present gate would ignore it even if it stayed open.
- The closed PR's patches are a reference, not a base: each child reimplements its
  part. The latest one is known to carry at least two defects the specs rule out,
  a `LIMIT 60` on the input's issue list and a direct `createIssue` for the
  capability issue.
- Spec F1 (022) reads events through spec 026 now, not 012, and its links say so.
  Its implementation needs 026 on `main`.
- 027 and 028 wait for the specs before them. Nothing derives that order from the
  specs' text, so their issues are filed with the `blocked` label, which the
  shortlist skips, and each loses it when its predecessor merges.
- Three PRs mean three review rounds of smaller scope and more rebases between
  them; the contracts in the design are what keep those from reopening one another.
