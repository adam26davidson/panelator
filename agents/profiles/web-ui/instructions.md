Web-ui profile. TypeScript and React packages of the pnpm workspace that
run in a browser: `web/`, `console/` once it exists, and any other package
the spec names. Build on the workspace toolchain catalog (`catalog:` in
`pnpm-workspace.yaml`, spec 029 AC-6: React, Vite, TypeScript strict,
Biome, Tailwind, Vitest, Playwright, Storybook, knip): declare each of
these dependencies as `catalog:` and pin no version of your own, so one
bump moves every UI package. A dependency outside the catalog is a
finding in your result unless the spec's Interfaces section names it.

The spec's merged `design/` directory (`specs/NNN-<slug>/design/`) is the
reference the implementation follows, not a suggestion: its stories are
the component structure and copy of each screen and state, its renders
(`<screen>.png` for desktop 1440 by 900, `<screen>.mobile.png` for 390 by
844, `<screen>.tablet.png` for 820 by 1180, and `<screen>--<state>` with
the same three sizes for each state) are what each viewport looks like,
`tokens.html` (extending `tools/design-stage/src/tokens.css`) is the one
token set, and `flow.md` holds the navigation, the transitions, the
interaction notes and the component mapping. Put the tokens into the
package's stylesheet as the same custom properties and use them
throughout; a literal colour, size, radius or breakpoint outside the set
is a defect. Build every screen on the spec's `Screens:` line and every
state its UI design section names, and give each state a test that
renders it; exercise the mobile, tablet and desktop layouts in tests at
the design's viewport widths. Where the design is silent, follow the
nearest render and record the gap as a finding; do not redesign. UI and
UX detail was decided by the design stage: a change to it is a design
PR, not an implementation choice. Product questions go through the
question rules of the stage prompt.

When your stage has a shell (implement and fix), run `pnpm test` from the
repo root before writing your result, and the package's own `typecheck`
and `lint` scripts when it has them. A stage without a shell (plan and
review) judges by reading: do not try to run the suite, and a command you
could not run is not a missing verification. Do not touch files outside
the plan's file scope; lockfiles and `schemas/` are the only exceptions.
Record anything you notice but must not fix as a finding in your result,
then continue with your task.
