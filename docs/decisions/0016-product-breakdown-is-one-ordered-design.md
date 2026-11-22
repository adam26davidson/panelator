# 0016. The product spec's breakdown is one flat design in milestone order

Status: accepted
Date: 2026-11-22
Decided by: the spec stage of issue #422 (design section 3: a decision of
structure and order with one clearly right answer under the rules that exist,
recorded with its reasoning). Carried by
[docs/designs/product-v0-build.md](../designs/product-v0-build.md).

## Context

`docs/product-spec.md` had no children, so no `class:product` issue existed
and every merge was system work whatever `system_work_share` said (delivery
plan #419, item 4). Issue #422 asks for the first planned children.

The maintainer has set the order: the runtime spike first, "if WASM cannot hit
60 Hz the runtime decision changes and everything downstream moves", then
board-side layout, then provisioning (design-tree R2.Q8, product spec 12).
The product spec sets no milestone after the third.

Two facts about spec 031 shape the answer. An `after:` line names siblings in
the same `## Children` section and nothing else. And an issue whose spec stage
authors a sub-design is closed when that design merges (AC-9), so a sibling
waiting on it is unblocked before any of the sub-design's work exists.

Options considered:

1. **A sub-design per area** (firmware, backend, web app, widgets), as the
   issue's wording suggests. Every milestone crosses all four areas, so every
   ordering edge would cross a design boundary, where `after:` cannot reach.
   All four areas' children would be filed unblocked, the marketplace beside
   the spike.
2. **A sub-design per milestone.** Milestone 2 would be `after:` the milestone
   1 design, whose issue closes when the design merges; milestone 2 would
   start before the spike has a result, against R2.Q8.
3. **Planned children for milestone 1 only.** It leaves most of the product
   spec with no child, and the next breakdown would again wait for a
   reflection to notice.
4. **One flat design, every child a sibling, ordered by `after:`** (chosen).

## Decision

- `docs/designs/product-v0-build.md` is a design under the product spec. Its
  children are spec-sized, one domain each, and cover milestones 1 to 3 in
  order; milestones 2 and 3 wait on the spike's measurement child.
- The rest of v0 is one child, `rest-of-v0`, filed blocked until the spike is
  measured. Its first act is the product question this breakdown found open,
  the milestones after 3; it then adds its breakdown to the same document, so
  those children can wait on the milestone 2 and 3 children. The question is
  not asked now because nothing in milestones 1 to 3 depends on the answer,
  the spike's result is what the maintainer would want in hand when
  answering, and asking now would hold back the first product issues.
- A child too large for one chain is split by replacing its bullet with
  sibling bullets in that document, not by a nested sub-design.
- The carrier PCB's move into `hardware/` depends on no milestone and is a
  planned child of the product spec itself.

## Consequences

- Five product issues are eligible when the design merges (the firmware
  project, the widget ABI and SDK, the backend workspace, the web app
  skeleton, the carrier PCB) and sixteen are filed with `blocked`.
- The plan stage has no implementation profile for the `firmware` and `widget`
  domains today, so those children stop at plan with `profile not available`
  until the profiles exist. That is delivery-system work and was reported as a
  finding by the run that wrote this ADR; the `backend` and `web-ui` children
  are not affected.
- The design's `## Children` section will grow long. It stays one list because
  the order lives there.
- If the product spec gains milestones or the spike fails, the planned bullets
  that have no spec yet are edited by a reviewed PR; issues already filed for
  removed bullets are closed by hand or by the chain that removes them.
