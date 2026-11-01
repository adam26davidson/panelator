# 2026-11-01: the design stage (spec 029, issue #38)

## What was built

- `tools/design-stage/`: the design package. A Storybook catalogue of `specs/*/design/*.stories.tsx`, a renderer
  (`pnpm -F @panelator/design-stage render <spec dir>`) that screenshots each named screen at mobile, tablet and
  desktop with Playwright and signs every PNG with a `panelator-render` tEXt chunk, and the base tokens.
- The `design` stage, the `design` review profile and `bounds.design_revisions` (default 2).
- The design track in the chain: a UI spec without its design starts the design stage on `design-<issue>`; the
  design PR is scope-checked, reviewed, fixed and merged like a spec PR; a gate that still fails on `main` reruns
  the design, then goes to the spec agent in `revise` mode.
- `uiDesignGate` requires three renders per screen and returns a reason, never a label. Issues parked with
  `needs-design-stage` are re-evaluated once (`design/relabelled.json` in the state directory).
- The workspace `catalog:` for the toolchain, and the `@playwright/browser-chromium` build approval beside esbuild.

## Setting up

`pnpm install` downloads Chromium through `@playwright/browser-chromium`'s install script (approved in
`allowBuilds`), into Playwright's browser cache. A fresh worktree's first `pnpm install` takes longer for that
download; nothing prompts.

## How `pnpm test` exercises the renderer

`tools/design-stage/test/render.test.ts` copies `test/fixtures/specs/900-fixture/` into a directory under the
operating system's temporary directory, builds its Storybook there, renders it headless at the three viewports,
and checks the six PNGs' sizes and `panelator-render` chunks. It also checks that a screen with no story fails.
Nothing is written into the repository. The tests have a 300 s timeout (a Storybook build and a Chromium launch).

## Next

The first real design run is the console's (spec 030, row E's second part). Its design PR and renders are to be
written up here after its merge.
