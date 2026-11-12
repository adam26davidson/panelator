# 054. CI installs Chromium with its system libraries on every run, uncached, and a test keeps it so

Status: written 2026-11-12 from the delivery-system design for issue #107;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (the chain has no human stops, so the required
`ci` check must not fail for a reason unrelated to the change);
[029-design-stage](../029-design-stage/spec.md) section 5 (the render test
in `pnpm test` and the `@playwright/browser-chromium` build approval; that
spec left `.github/` alone);
[035-pnpm-pinned-and-install-before-run](../035-pnpm-pinned-and-install-before-run/spec.md)
AC-7 (the test that already reads `.github/workflows/ci.yml`, which this
spec extends).

## 1. Goal

Since spec 029, `pnpm test` builds a fixture Storybook and renders it in
headless Chromium (`tools/design-stage/test/render.test.ts`), so the `ci`
workflow needs the browser and the shared libraries it links against.
Issue #107 reports that the workflow downloads the browser on every run
and never installs those libraries, so the render test launches only
because `ubuntu-latest` happens to ship them.

What `main` does today (verified while writing this spec): the workflow
already has the step
`pnpm -F @panelator/design-stage exec playwright-core install --with-deps chromium`
between `pnpm install --frozen-lockfile` and `pnpm test`, added by commit
42010d9 in PR #118. `--with-deps` installs Chromium's system libraries
through `apt-get` before the browser, so a runner image that lacks or
cannot install them fails at that step, by name, rather than with a
missing-library error inside the render test. The issue's second half is
therefore already done; nothing guards it, though: a later edit to
`ci.yml` could drop or reorder the step and the suite would still pass
for as long as the runner image happens to carry the libraries.

On the first half, this spec decides to keep downloading the browser on
every run rather than cache `~/.cache/ms-playwright` *(agent's call)*:

- Playwright's CI guide ("Caching browsers", playwright.dev/docs/ci)
  advises against caching the browser binaries: restoring the cache takes
  about as long as downloading them, and on Linux the operating-system
  dependencies, which are not cacheable, are installed on every run
  anyway. The `--with-deps` step above runs `apt-get` on every run whether
  or not the browser is cached, so a cache saves at most the few seconds
  between the two transfers.
- A cache is one more piece of state that can disagree with the lockfile.
  The step itself exists because cached state already broke CI once:
  when setup-node restored the pnpm store, the
  `@playwright/browser-chromium` install script did not run and nothing
  restored the browser, so the render test failed on every cache hit
  (commit 42010d9's message). One unconditional install with a pinned
  `playwright-core` (the catalog pins it to the same exact version as
  `@playwright/browser-chromium`, guarded by the existing catalog test)
  has no such second path.
- The repository is public, so runner minutes cost nothing; the gain a
  cache would buy is a few seconds of wall-clock per run.

The decision is small and cheap to reverse (one `actions/cache` step), so
it is recorded here rather than in an ADR. What this spec changes is the
guard: a test in `pnpm test` that fails when the workflow stops installing
Chromium with its libraries before the suite, and a comment in `ci.yml`
that says why the browser is not cached, so the step is not "fixed" again
by the next reader.

## 2. Out of scope

- An `actions/cache` step for `~/.cache/ms-playwright`, or any other
  browser cache (section 1 decides against it).
- The pnpm store cache (`actions/setup-node` with `cache: pnpm`):
  unchanged.
- `pnpm-workspace.yaml`, its `allowBuilds` approval of
  `@playwright/browser-chromium` and its catalog: unchanged. The install
  script still downloads Chromium on a developer's or a stage's
  `pnpm install`, which is how a worktree gets the browser (spec 029).
- `tools/design-stage/` (its `package.json`, the renderer, the render
  test): unchanged.
- Any other workflow, a `timeout-minutes`, `concurrency` or `paths:`
  setting for `ci.yml`, and the required-check configuration: unchanged.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

- AC-1. **Chromium and its libraries are installed before the suite.**
  Given `.github/workflows/ci.yml`, when `jobs.test.steps` is read, then
  exactly one step has a `run` that installs Chromium with its system
  libraries: its `run`, split on whitespace, contains `playwright-core`,
  `install`, `--with-deps` and `chromium`, in that order (today's
  `pnpm -F @panelator/design-stage exec playwright-core install --with-deps chromium`
  satisfies it). That step comes after the step whose `run` is
  `pnpm install --frozen-lockfile` and before the step whose `run` is
  `pnpm test`.
- AC-2. **The browser is not cached.** Given the same steps, then no step
  whose `uses` starts with `actions/cache` names a path containing
  `ms-playwright` (`with.path`, as a string or any line of a multi-line
  string). The `actions/setup-node` step keeps `cache: pnpm`.
- AC-3. **The workflow says why.** Given `.github/workflows/ci.yml`, then
  the line directly above the Chromium install step is a YAML comment
  stating that the step installs the browser and its system libraries on
  every run, that the browser is deliberately not cached, and naming
  spec 054. No other step of the workflow changes: checkout,
  `pnpm/action-setup` (still without `with.version`, spec 035 AC-1),
  setup-node, the frozen install, the Chromium install's own `run` text,
  `pnpm test` and the typecheck are as on `main`.
- AC-4. **A test guards it.** Given `pnpm test` from the repository root,
  then a test reads `.github/workflows/ci.yml` relative to the test file
  and asserts AC-1 and AC-2. The test passes on the implementation PR. It
  fails when the Chromium install step is removed, when `--with-deps` is
  removed from it, when it is moved after `pnpm test`, and when an
  `actions/cache` step with `path: ~/.cache/ms-playwright` is added
  (checked by the implementer against edited copies of the workflow
  parsed in the test itself, not by editing `ci.yml`: the test's
  assertions are a function of the parsed workflow, applied to the real
  file and to these four in-test variants, which must each fail it).
- AC-5. **CI still passes.** Given the implementation PR, when the `ci`
  workflow runs, then the Chromium install step, `pnpm test` (including
  `tools/design-stage/test/render.test.ts` and the new test) and the
  typecheck pass.

## 4. Amendments to earlier specs

None. Spec 029 section 5 kept the implementation out of `.github/`; this
spec does not change what spec 029 says, it covers the file spec 029 left.

## 5. Interfaces and files

This list is the implementation's file scope.

- `.github/workflows/ci.yml`: one YAML comment line added directly above
  the existing `- run: pnpm -F @panelator/design-stage exec playwright-core install --with-deps chromium`
  step, for example
  `# Chromium and its system libraries, every run; the browser is not cached (spec 054).`
  Nothing else in the file changes (AC-3).
- `tools/scheduler/test/workspace-config.test.ts`: gains a
  `describe("CI installs Chromium with its libraries (spec 054)")` block
  beside the spec 035 block. It parses `ci.yml` with the `yaml` package the
  file already imports, through a small local function
  `checkChromiumSteps(steps)` that returns the list of AC-1 and AC-2
  violations (empty when the workflow is right). One test asserts the list
  is empty for the real workflow; one test builds the four variants of
  AC-4 from the parsed steps (filter out the step, strip `--with-deps`
  from its `run`, move it after `pnpm test`, insert
  `{ uses: "actions/cache@v4", with: { path: "~/.cache/ms-playwright", key: "x" } }`)
  and asserts the list is non-empty for each. The existing tests in the
  file are unchanged. The test lives here, not in `tools/design-stage/`,
  because this file already holds the workflow and workspace guards and
  has `yaml` as a dependency.

The spec PR itself adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

`.github/` and `tools/scheduler/` are sensitive paths
(`agents/sensitive-paths.txt`), so the implementation PR gets the security
review (spec 006 AC-9). The change does not drop, skip or narrow what
`pnpm test` runs or what the `ci` workflow runs: it adds a comment to the
workflow and a test to the suite. This spec plans no change to the
charter, to a protected maintainer decision, to the sensitive-path list,
to the security review criteria, or to what routes a sensitive diff to the
security review.

## 6. Verification

- AC-1, AC-2, AC-4: `pnpm test` from the repository root passes, including
  the new tests; the variant test shows each of the four edits is caught.
  `pnpm -F @panelator/scheduler typecheck` is clean.
- AC-3: `git diff main -- .github/workflows/ci.yml` shows one added
  comment line and nothing else.
- AC-5: the implementation PR's `ci` check is green; its log shows the
  `playwright-core install --with-deps chromium` step running `apt-get`
  and the render test passing.

## 7. Open decisions

None.
