# 055. The design package has a `lint` script that runs Biome and knip, and CI runs it

Status: written 2026-11-12 from the delivery-system design for issue #108;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (the chain has no human stops, so what guards the
code must run somewhere no agent can skip);
[design-tree R5.Q4](../../docs/design-tree.md) (Biome and knip are the
decided frontend tooling);
[029-design-stage](../029-design-stage/spec.md) AC-6 and section 5 (the
package pins the toolchain, including Biome and knip, and carries
`biome.json` and `knip.json`, but names no step that runs them);
[054-ci-installs-chromium-with-its-libraries](../054-ci-installs-chromium-with-its-libraries/spec.md)
section 5 (the workflow test in `tools/scheduler/test/workspace-config.test.ts`
that this spec extends).

## 1. Goal

`tools/design-stage/` declares `@biomejs/biome` and `knip` as
devDependencies (through the catalog) and carries `biome.json` and
`knip.json`, yet nothing runs either tool: the package's scripts are
`storybook`, `render`, `test` and `typecheck`, the root `package.json` has
only `test`, and the `ci` workflow runs `pnpm test` and the scheduler
typecheck. Issue #108 asks for either a `lint` script run from CI or the
removal of the two dependencies and their configs.

This spec takes the first option *(agent's call)*: design-tree R5.Q4 decides
Biome and knip for the frontend, spec 029 AC-6 pins them in the catalog so
`console/` and `web/` reuse one version, and a tool that is pinned but never
run is the rot the issue describes. Dropping them would only move the work
to the console's spec.

What the tools report today (verified while writing this spec, in a
worktree of `main` at commit f0c513f, with `pnpm exec` inside
`tools/design-stage/`):

- `biome check .` checks 15 files and finds 6 errors, 1 warning and 1
  info: the formatter would reprint `.storybook/main.ts`, `knip.json`,
  `package.json`, `src/render.ts` and `test/render.test.ts`; the imports of
  `.storybook/main.ts` are not sorted (`assist/source/organizeImports`); and
  `src/render.ts:158` reads `innerText` where
  `lint/performance/useDomNodeTextContent` recommends `textContent`
  (a warning).
- `knip` run from the package directory reports "Unresolved catalog
  references (16)": knip resolves `catalog:` from the `pnpm-workspace.yaml`
  of the directory it treats as the root, and the package directory has
  none. Run from the repository root and scoped to the package with
  `knip --directory ../.. --config tools/design-stage/knip.json --workspace tools/design-stage`
  (with `knip.json` rewritten in `workspaces` form, section 5), every
  catalog reference resolves and knip reports: unused dependencies
  `@vitejs/plugin-react` and `tailwindcss`, unused devDependency
  `@biomejs/biome`, unused export `namedScreens` (`src/render.ts`), unused
  exported type `ViewportName` (`src/viewports.ts`), and two configuration
  hints (a redundant `src/cli.ts` entry, which knip already finds from the
  `render` script, and `.css` imports not followed). With
  `@playwright/browser-chromium` not yet ignored it is reported unused too:
  nothing imports it; its install script downloads Chromium (spec 029 AC-6).

So the change is: a `lint` script in the package that runs Biome's check
over the package and knip over the package as one workspace of the
repository root; the package's own files brought to a clean report; a step
in `ci.yml` that runs the script, as the scheduler typecheck already runs
there; and a test in `pnpm test` that fails when that step or the script
disappears, so the configs cannot lose their consumer again unnoticed.

Where knip's configuration lives is a small, reversible choice, so it is
recorded here rather than in an ADR *(agent's call)*: `knip.json` stays in
`tools/design-stage/`, where spec 029 section 5 lists it and where the
package's other configs are, and the script hands knip the repository root
and the config path. A root `knip.json` would also work, but it would make
the root the owner of a lint that only this package runs, and it would
leave the package's `knip.json` as a file knip never reads.

## 2. Out of scope

- A `lint` script in the root `package.json` (a sensitive path; CI calls
  the package script directly, as it calls the scheduler's `typecheck`).
- Running Biome or knip over `tools/scheduler/`, over the stories under
  `specs/*/design/`, or over any other package: the script checks
  `tools/design-stage/` only. The console's spec decides the console's
  lint.
- Running the lint from `pnpm test` or from a stage's instructions
  (`AGENTS.md`, the profiles): the lint is a CI step, like the typecheck.
- Changing Biome's rule set beyond what section 5 says (`recommended`
  stays), the catalog versions in `pnpm-workspace.yaml`, or
  `pnpm-workspace.yaml` at all.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

- AC-1. **The package has a `lint` script.** Given
  `tools/design-stage/package.json`, when its `scripts` are read, then
  they include `lint`, whose command runs Biome's `check` over the package
  directory and then knip over the package as a workspace of the
  repository root, so that `catalog:` references resolve: the command,
  split on whitespace, contains `biome`, `check`, `knip` and
  `--workspace`, in that order. The existing scripts `storybook`, `render`,
  `test` and `typecheck` are unchanged. Given the implementation PR, when
  `pnpm -F @panelator/design-stage lint` runs from the repository root or
  from `tools/design-stage/`, then it exits 0.
- AC-2. **Biome is clean.** Given the package's files, when
  `biome check .` runs in `tools/design-stage/`, then it reports no error:
  the formatting of the five files of section 1 and the import order of
  `.storybook/main.ts` are fixed in those files, and the
  `useDomNodeTextContent` warning in `src/render.ts` is resolved, either by
  reading `textContent` or by a `biome-ignore` comment that gives the
  reason (implementer's call; the render test's error message for a story
  that throws must still name the story's error). `biome.json` keeps
  `linter.rules.recommended: true` and the formatter settings it has today.
  Given a `storybook-static/` directory left in the package by a local
  Storybook build, then `biome check .` does not read it (`biome.json`
  excludes it, or enables Biome's use of the git ignore file).
- AC-3. **knip is clean.** Given the lint script's knip invocation, when it
  runs on the implementation PR, then knip reports no issue and exits 0:
  no unresolved catalog reference; `@biomejs/biome` is used (by the `lint`
  script); `namedScreens` in `src/render.ts` and `ViewportName` in
  `src/viewports.ts` are no longer exported (each is used only in its own
  file); and every dependency knip would report unused is either removed
  from `package.json` (with `pnpm-lock.yaml` following) or listed in
  `knip.json`'s `ignoreDependencies` for a reason recorded in section 5.
  `@playwright/browser-chromium` is kept and ignored (its install script
  provides the browser). `tailwindcss` is kept and ignored (imported by
  `src/tokens.css`, which knip does not follow). `@vitejs/plugin-react` is
  removed if the Storybook build of the render test and
  `pnpm -F @panelator/design-stage storybook` still work without it, and
  otherwise kept and ignored with the reason (`@storybook/react-vite` does
  not list it as a dependency or peer dependency, so the render test
  decides). Configuration hints are resolved where knip's hint is right
  (the redundant `src/cli.ts` entry) and may otherwise remain; they do not
  fail the run.
- AC-4. **CI runs it.** Given `.github/workflows/ci.yml`, when
  `jobs.test.steps` is read, then exactly one step has the `run`
  `pnpm -F @panelator/design-stage lint`, and it comes after the step whose
  `run` is `pnpm install --frozen-lockfile`. It is placed directly after
  the scheduler typecheck step. No other step changes: checkout,
  `pnpm/action-setup`, setup-node, the frozen install, the Chromium
  install with its comment (spec 054 AC-3), `pnpm test` and the typecheck
  are as on `main`.
- AC-5. **A test guards it.** Given `pnpm test` from the repository root,
  then a test in `tools/scheduler/test/workspace-config.test.ts` reads
  `.github/workflows/ci.yml` and `tools/design-stage/package.json` relative
  to the test file and asserts AC-4's step (present once, after the frozen
  install) and AC-1's script (present, with `biome`, `check`, `knip` and
  `--workspace` in that order). It passes on the implementation PR and
  fails when the lint step is removed from the workflow and when the
  `lint` script is removed from the package (checked, as in spec 054 AC-4,
  against in-test variants of the parsed files, not by editing the real
  ones).
- AC-6. **Everything still passes.** Given the implementation PR, when the
  `ci` workflow runs, then `pnpm test` (including
  `tools/design-stage/test/render.test.ts` and the new test), the
  scheduler typecheck and the new lint step pass, and
  `pnpm -F @panelator/design-stage typecheck` is clean.

## 4. Amendments to earlier specs

None. Spec 029 section 5 lists the package's scripts as they were when it
landed; adding `lint` extends that list as `typecheck` already did, and
nothing spec 029 says stops applying.

## 5. Interfaces and files

This list is the implementation's file scope.

- `tools/design-stage/package.json`: the `lint` script, for example
  `"lint": "biome check . && knip --directory ../.. --config tools/design-stage/knip.json --workspace tools/design-stage"`
  (this exact knip invocation was verified to resolve the catalog, section
  1). `@vitejs/plugin-react` is dropped from `dependencies` if AC-3's test
  allows. Formatted by Biome. Nothing else changes.
- `tools/design-stage/biome.json`: excludes `storybook-static/` (AC-2),
  for example `"files": { "includes": ["**", "!storybook-static"] }`, or
  `"vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true }`.
  Formatter and linter settings unchanged.
- `tools/design-stage/knip.json`: rewritten in `workspaces` form so knip
  reads it from the repository root, for example
  `{ "workspaces": { "tools/design-stage": { "entry": [...], "project": [...], "ignoreDependencies": [...] } } }`,
  with the entries of today's file (minus the redundant `src/cli.ts`, which
  knip finds from the `render` script) and `ignoreDependencies` holding
  `@playwright/browser-chromium` (install script only), `tailwindcss`
  (imported from `src/tokens.css`) and, if kept, `@vitejs/plugin-react`
  (needed by the Storybook build). Those are the reasons AC-3 refers to.
- `tools/design-stage/.storybook/main.ts`, `src/render.ts`,
  `test/render.test.ts`: formatting and import order per Biome; `render.ts`
  also loses the `export` on `namedScreens` and resolves the `innerText`
  warning (AC-2, AC-3).
- `tools/design-stage/src/viewports.ts`: `ViewportName` loses its `export`.
- `.github/workflows/ci.yml`: one step added after the typecheck step,
  `- run: pnpm -F @panelator/design-stage lint` (AC-4). Nothing else in
  the file changes.
- `tools/scheduler/test/workspace-config.test.ts`: gains a
  `describe("CI runs the design package's lint (spec 055)")` block beside
  the spec 054 block, parsing `ci.yml` with the `yaml` package the file
  already imports and reading the package's `package.json` with
  `JSON.parse`. A small local function returns the list of AC-4 and AC-1
  violations for a given step list and script map; one test asserts it is
  empty for the real files, one asserts it is non-empty for the two
  variants of AC-5. Existing tests unchanged.
- `tools/README.md`: the design-package bullet gains a sentence naming
  `pnpm -F @panelator/design-stage lint` (Biome and knip, run by CI).
- `pnpm-lock.yaml`: follows `package.json` if a dependency is dropped.

The spec PR itself adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

`.github/` and `tools/scheduler/` are sensitive paths
(`agents/sensitive-paths.txt`), so the implementation PR gets the security
review (spec 006 AC-9). The change does not drop, skip or narrow what
`pnpm test` runs or what the `ci` workflow runs: it adds a step to the
workflow and a test to the suite. This spec plans no change to the
charter, to a protected maintainer decision, to the sensitive-path list,
to the security review criteria, or to what routes a sensitive diff to the
security review.

## 6. Verification

- AC-1, AC-2, AC-3: `pnpm -F @panelator/design-stage lint` exits 0 from the
  repository root and from `tools/design-stage/`; its output shows Biome
  checking the package's files with no error and knip with no issue and no
  "Unresolved catalog references". `biome check .` in the package reports
  no error on its own.
- AC-5: `pnpm test` from the repository root passes, including the new
  tests; the variant test shows each of the two removals is caught.
  `pnpm -F @panelator/scheduler typecheck` and
  `pnpm -F @panelator/design-stage typecheck` are clean.
- AC-4: `git diff main -- .github/workflows/ci.yml` shows one added step
  and nothing else.
- AC-3, AC-6: `pnpm test` still passes the render test after any dependency
  removal, and the implementation PR's `ci` check is green with the lint
  step in its log.

## 7. Open decisions

None.
