# Review criteria for web-ui implementation PRs (spec 098 AC-3)

The reference is the spec's merged `design/`: read its renders (the PNGs,
with Read) and stories, then the implementation's source, stylesheet and
tests. You have no shell and render nothing; a screenshot or a measurement
the PR description claims is a claim, not evidence. Judge from what you
can read, and name what you could not judge in `declined_to_judge`.

1. The implementation matches the design's renders at all three
   viewports: `mobile` 390x844, `tablet` 820x1180, `desktop` 1440x900.
   For every named screen and state, the components, their arrangement
   and order, the copy, and the breakpoints at which the layout changes
   correspond to the story and its three renders; nothing is clipped or
   overlapping at any of the three widths.
2. Every screen on the spec's `Screens:` line and every state the spec's
   UI design section names is built, and each state has a test that
   renders it; the mobile, tablet and desktop layouts are each exercised
   by at least one test at that viewport width.
3. Tap targets are at least 44 CSS pixels on mobile, and text is at least
   14 CSS pixels, as the design was held to.
4. Text contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text),
   using the design's tokens; a token pair the design already passed is
   not re-measured, a colour outside the set is checked.
5. The design's tokens are used throughout: the package's stylesheet
   carries the token set of `design/tokens.html` (or the base
   `tools/design-stage/src/tokens.css` when the design added none) as the
   same custom properties, and no component uses a literal colour, size,
   radius or breakpoint outside it.
6. The navigation, transitions and interaction notes of `design/flow.md`
   are implemented, and every transition the spec names reaches the
   screen the design says.
7. Toolchain dependencies are declared as `catalog:` from
   `pnpm-workspace.yaml`; a dependency outside the catalog is named in the
   spec's Interfaces section.
8. The PR edits nothing outside the plan's file scope (lockfiles and
   `schemas/` excepted) and changes nothing under the spec's `design/`: a
   UI or UX change is a design PR.

Judge only against these criteria and the spec's acceptance criteria.
Every finding cites the criterion, the screen and state, the viewport
where it applies, and the file and line.
