# 112. Web app: the React project in web/ with its toolchain and checks

Status: written 2026-11-23 for issue #434, the planned child
`web-app-skeleton` of the v0 build design; a spec derived from its parent
design needs no maintainer approval (delivery-system design section 11).
Marks no earlier spec.
Class: product. Domain: web-ui (sensitive paths: `pnpm-workspace.yaml`,
`vitest.config.ts` and `web/vitest.config.ts`, the test wiring;
process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 (the web app's skeleton is one of milestone 1's four starting
points) and 4 ("Geometry is configuration", "Checks arrive with the layer")
and its planned child `web-app-skeleton`;
[product spec](../../docs/product-spec.md) sections 7 (the stack), 13 (per
layer: Biome, steiger, knip, Vitest, Playwright) and 14 (`web/` is the React
app, FSD), and its non-goals (web app localisation);
[design-tree](../../docs/design-tree.md) R4.Q9 (frontend TypeScript,
Feature-Sliced Design, "tooling must enforce cleanliness") and R5.Q4 (the
frontend toolchain); [spec 029](../029-design-stage/spec.md) AC-6 (the
toolchain catalog in `pnpm-workspace.yaml` that `console/` and `web/` reuse);
[spec 051](../051-console/spec.md) (the console package, whose scripts and
`pnpm test` wiring this spec follows where the product's stack allows);
[spec 098](../098-web-ui-profile/spec.md) (the profile that implements and
reviews this); [spec 054](../054-ci-installs-chromium-with-its-libraries/spec.md)
(CI installs Chromium before the suite);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

## 1. Goal

`web/` holds only `.gitkeep`. After this spec it holds the product's web app
as the workspace package `@panelator/web`: a React app built by Vite in
strict TypeScript, laid out in Feature-Sliced Design layers that steiger
enforces, formatted and linted by Biome, routed by TanStack Router with
TanStack Query provided to every route, styled by Tailwind from one token
set, unit-tested by Vitest with Testing Library, tested in a real browser by
Playwright, catalogued in Storybook, and kept free of dead code by knip.

The app itself is a shell: a frame around one route, `/`, that says what
panelator is, plus the two screens any router needs (an unknown address, and
a route that failed). Nothing in it talks to a backend.

What the later web children get from it: a place for every kind of file,
and checks that already run. `pnpm test` at the repository root, and so CI's
required `test` job, runs the type check, Biome, steiger, knip, the unit
tests, the production build, the Storybook build and the browser tests of
the package, each reported under its own name. `simulator-engine`,
`layout-editor` and `web-login-and-boards` add routes, slices and tests and
change no wiring.

## 2. Out of scope

- **The simulator, the editor, login, boards, live control.** No WASM, no
  canvas, no panel, no forms: `simulator-engine`, `layout-editor`,
  `web-login-and-boards` and `rest-of-v0`.
- **Any backend call.** No API client, no base URL setting, no generated
  types from `schemas/` (`screen-config-and-type-sharing`), no auth, no
  cookies, no storage. TanStack Query is provided and nothing queries yet.
- **Deploying the app.** Hosting and the automatic web deploy are
  `rest-of-v0` (product spec 5.4). The build output is checked to build and
  to run; it is published nowhere.
- **A Zustand store.** Section 4, "Zustand".
- **Localisation** (a product non-goal): copy is English, written in the
  components.
- **Visual regression testing** (comparing screenshots against the design's
  renders). The design's renders are judged by the review (spec 098); the
  browser tests check structure and layout rules, not pixels.
- **The console and the design stage's catalogue.** Unchanged, apart from two
  lines of `console/package.json` that move to the catalog (AC-1).
- **The workflows, the root manifest and the automation.** Nothing under
  `.github/`, `tools/` or `agents/` changes, nor the root `package.json` or
  `AGENTS.md`: CI already runs `pnpm test` (AC-14). The sensitive-path list,
  the security review and what routes a diff to it are unchanged.

## 3. Acceptance criteria

Definitions. *The package* is `@panelator/web` in `web/`. *The catalog* is
the `catalog:` block of `pnpm-workspace.yaml`. *The three viewports* are
`mobile` 390 by 844, `tablet` 820 by 1180 and `desktop` 1440 by 900 CSS
pixels (spec 029 AC-5). *The design* is this spec's merged `design/`
directory. *A check* is one of the package's scripts named in AC-12.

**The package**

- AC-1. **One package, on the catalog.** `web/package.json` names the
  package `@panelator/web`, private, `"type": "module"`, `engines.node`
  `>=26`, with the scripts `dev` (the Vite dev server), `build`, `preview`,
  `typecheck`, `lint`, `fsd`, `knip`, `test`, `storybook`, `build-storybook`
  and `e2e`. Every dependency it declares is `catalog:`, except
  `@types/node`, declared at the range the other workspace packages use. The
  catalog gains `@tanstack/react-router` and `@tanstack/react-query` at the
  ranges `console/package.json` declares today (those two lines of
  `console/package.json` become `catalog:`, so the workspace has one version
  of each), and `zustand`, `steiger`, `@feature-sliced/steiger-plugin`,
  `@testing-library/user-event` and `@playwright/test`. `@playwright/test`
  is the exact version of the catalog's `playwright-core` and
  `@playwright/browser-chromium`, so the one Chromium already downloaded
  serves all three; the others are caret ranges on the newest release the
  workspace's install accepts when the implementation is written. No
  `allowBuilds` entry is added. Given the implementation needs a dependency
  this criterion does not name and the catalog does not hold, then it is
  added to the catalog, used as `catalog:`, and recorded as a finding in the
  implementation's result. `web/.gitkeep` is removed.
- AC-2. **TypeScript strict.** `web/tsconfig.json` sets `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch`, with the module settings of
  `console/tsconfig.json` (`moduleResolution: bundler`, `jsx: react-jsx`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noEmit`). Given any
  TypeScript file of the package (source, tests, stories, browser tests,
  `checks.test.ts` and every config file) has a type error, when
  `pnpm -F @panelator/web typecheck` runs, then it exits non-zero. Imports
  from one layer or slice to another use the alias `@/` for `web/src/`,
  which TypeScript, Vite, Vitest and Storybook resolve alike; imports inside
  a slice are relative.
- AC-3. **Feature-Sliced Design, enforced by steiger.** `web/src/` holds
  FSD layers and nothing else at its top level. This spec creates `app`
  (the entry, the providers, the router, the stylesheet), `pages` (one slice
  per screen: `home`, `not-found`, `error`) and `shared` (`ui`, `lib`,
  `config` segments as needed); `widgets`, `features` and `entities` are
  created by the first child that has something for them. Every slice
  exposes a public API (`index.ts`) and is imported only through it.
  `pnpm -F @panelator/web fsd` runs steiger over `web/src` with
  `web/steiger.config.ts`, which applies the recommended rule set of
  `@feature-sliced/steiger-plugin`. Given `web/src` as this spec leaves it,
  then the script exits 0 with no diagnostic. Given the fixture tree
  `web/test/fixtures/fsd/upward-import/` (a file in `shared` importing from
  `pages`), and given `web/test/fixtures/fsd/public-api-sidestep/` (a page
  importing a file inside another slice past its `index.ts`), when steiger
  runs on each with the package's config, then it exits non-zero and its
  output names the rule; a unit test of the package runs both. A recommended
  rule may be switched off in the config only when the skeleton's size alone
  trips it (for example a slice with a single consumer), with the reason in
  a comment beside it; the rules on import direction, public APIs and layer
  and segment names stay on. The fixture trees are excluded from the type
  check, Biome and knip, and from the run over `web/src`.
- AC-4. **Biome.** `web/biome.json` uses the formatter settings of the
  other packages (spaces, width 2, line width 120) and the recommended
  linter rules with no rule switched off. `pnpm -F @panelator/web lint` runs
  `biome check .`; given a file of the package is unformatted or breaks a
  rule, then it exits non-zero. Only generated output is excluded (`dist`,
  `storybook-static`, Playwright's output directories), the FSD fixtures of
  AC-3, and the stylesheet holding the Tailwind directives if Biome cannot
  parse them, as `console/biome.json` does.
- AC-5. **knip.** `pnpm -F @panelator/web knip` runs knip for the workspace
  `web` with `web/knip.json`, in the way the console's `lint` script does.
  Given a source file nothing reaches, an export nothing imports, or a
  declared dependency nothing uses, then it exits non-zero.
  `ignoreDependencies` holds only packages that are used without being
  imported (`tailwindcss`, `@playwright/browser-chromium`).

**The app**

- AC-6. **The shell and its routes.** `web/index.html` (`lang="en"`, a
  viewport meta tag, the title `panelator`) loads the entry in `src/app/`,
  which mounts one `QueryClientProvider` and one `RouterProvider`. The route
  tree is declared in code in the `app` layer with TanStack Router *(section
  4, "Routes in code")* and registered for type checking, so a `Link` to a
  path that does not exist is a type error. The root route renders the
  frame, which every screen is shown inside: a `banner` landmark carrying
  the product's name as a link to `/`, and a `main` landmark holding the
  matched route. The frame's layout at the three viewports is the design's.
  The router is built by a function that takes its history, so a test builds
  one with a memory history at any address; each app instance and each test
  gets its own `QueryClient`.
- AC-7. **Home.** Given the address `/`, then the frame shows the `home`
  page: one `h1` and the copy the design gives, which says what panelator
  is. It offers no control and no link that leads to something this spec
  does not build (no sign-in, no board, no editor). The document title is
  `panelator`.
- AC-8. **Not found.** Given any address no route matches, when the app
  loads there or navigates there, then the frame shows the `not-found` page:
  one `h1`, the copy the design gives, and a link to `/`; following it shows
  Home at `/` without a page load. The document title is
  `Page not found · panelator`.
- AC-9. **A route that fails.** Given a route's component or loader throws,
  then the frame stays and shows the `error` page in place of the route: one
  `h1`, the copy the design gives, a control that reloads the page, and a
  link to `/`. The error's message and stack are written to the browser
  console and never shown on the page. The document title is
  `Something went wrong · panelator`.
- AC-10. **Tailwind from the design's tokens.** Tailwind is loaded through
  `@tailwindcss/vite`. The stylesheet in `src/app/` carries the token set of
  `design/tokens.html` as the same custom properties and maps them into
  Tailwind's theme, so utilities are the tokens. No component and no
  stylesheet uses a literal colour, font size, spacing, radius or breakpoint
  outside that set (spec 098, review criterion 5).

**The tests**

- AC-11. **Vitest with Testing Library.** `web/vitest.config.ts` runs
  `src/**/*.test.{ts,tsx}` in jsdom and nothing else (not `checks.test.ts`,
  not the browser tests). Tests sit beside the code they test. A helper in
  `shared` renders the app at a given address with the providers of AC-6.
  The tests cover: Home at `/` (AC-7); the not-found page at an unknown
  address, and the link back reaching Home (AC-8); the error page for a
  route whose component throws, with the frame still present and no message
  or stack in the document (AC-9); the document title of each; and the two
  steiger fixtures of AC-3. Given a test fails, then
  `pnpm -F @panelator/web test` exits non-zero.
- AC-12. **Storybook.** `web/.storybook/` configures Storybook with the
  `@storybook/react-vite` framework, the app's stylesheet and Tailwind, and
  serves `web/src/**/*.stories.tsx`. Each of the three pages has a story
  showing it inside the frame, and each component in `shared/ui` has one.
  `pnpm -F @panelator/web build-storybook` builds the catalogue into
  `web/storybook-static/` (git-ignored) and exits non-zero on any error. A
  unit test renders every story of the package through Storybook's portable
  stories and fails on a story that throws, so a story cannot rot between
  catalogue builds.
- AC-13. **Playwright.** `pnpm -F @panelator/web e2e` runs `@playwright/test`
  over `web/e2e/*.spec.ts` against the production build, built by
  `vite build` and served by `vite preview`, both started by Playwright's
  own web server setting. The port is a free one found when the run starts,
  never a fixed number (AC-15). The browser is the Chromium that
  `@playwright/browser-chromium` installed; the script downloads nothing and
  runs no other browser. There is one Playwright project per viewport, and
  every test runs in all three. The tests:
  - Home loads at `/`: the `banner` and the `h1` are visible, the page
    scrolls nowhere sideways (`scrollWidth` no greater than the window's
    width), and no uncaught error and no console error occurred;
  - an unknown address loaded directly (for example `/no/such/place`) shows
    the not-found page, so the server's fallback to `index.html` is part of
    what is tested, and its link leads to Home at `/`;
  - on `mobile`, every link and button on the two screens these tests
    reach is at least 44 CSS pixels in both dimensions.

  `forbidOnly` is on when `CI` is set, and retries are 0. Playwright's
  output directories are git-ignored. The files end in `.spec.ts` so that
  neither Vitest config collects them.

**The wiring**

- AC-14. **`pnpm test` runs every check.** `web/checks.test.ts` is a Vitest
  file that the root configuration runs. It has one test per check, named
  for it and run in this order: `typecheck`, `lint`, `fsd`, `knip`, `test`,
  `build`, `build-storybook`, `e2e`. Each runs
  `pnpm -F @panelator/web <script>` from the repository root with Vitest's
  own environment variables and `NODE_ENV` removed, as
  `tools/scheduler/test/console-package.test.ts` does for the console, and
  given the script exits non-zero, then that test fails showing the end of
  the script's output. One more test reads `pnpm-workspace.yaml` and
  `web/package.json` and asserts the dependency rule of AC-1 (every entry
  `catalog:` but `@types/node`; the three Playwright packages at one exact
  version). The root `vitest.config.ts` changes in one place: the include
  entry `web/**/*.test.ts` becomes `web/checks.test.ts`, so the package's
  own tests run once, under the package's configuration, and not a second
  time without jsdom under the root's *(section 4, "How `pnpm test` reaches
  the package")*. Nothing else in the root configuration changes, and no
  test file of another package is removed from the run. CI's `test` job
  already installs Chromium with its libraries and then runs `pnpm test`
  (spec 054), so every check runs there and a failing one fails the required
  check; `.github/workflows/ci.yml` is not changed.
- AC-15. **Two runs at once.** Given two checkouts of the repository on one
  machine running `pnpm test` at the same time, as two pipeline worktrees
  do, then neither run's web checks fail because of the other: no check
  listens on a fixed port, and none writes outside its own checkout except
  to the operating system's temporary directory under a name of its own and
  to Playwright's shared browser cache, which it only reads.
- AC-16. **The README.** `web/README.md` states, in under a page: the
  scripts and what each checks; the layers and what goes in each, with the
  rule that the simulator engine is shared code or its own package and never
  a feature slice (product spec 7); that a Zustand store lives in the
  `model` segment of the slice that owns the state, and is added with the
  first state that needs one; that tokens come from the design and no
  literal value is used; and that no file in `web/` hard-codes a panel's
  width, height or chain length (the v0 build design, "Geometry is
  configuration"). The root `README.md` gains one line saying how to start
  the app (`pnpm -F @panelator/web dev`).

## 4. Design notes *(agent's calls)*

**The domain is `web-ui`.** The work lies in `web/` and builds screens, so
the design stage designs the frame and the three screens before the
implementation starts (spec 029), and the implementation is reviewed against
those renders (spec 098). The screens are small; the frame and the token set
they fix are what every later web child builds inside, which is the reason
to design them once, here, rather than let the first feature child do it as
a side effect.

**How `pnpm test` reaches the package.** The root Vitest configuration
includes `web/**/*.test.ts`. Left as it is, it would run the package's own
`.test.ts` files a second time in the root project, with no jsdom and none
of the package's setup, and would miss its `.test.tsx` files and every check
that is not a Vitest test. The console solved the same problem with one
wrapper file that runs the package's scripts and reports each by name; this
spec does the same, and puts the wrapper in `web/` so that a product check
does not live under `tools/scheduler/`. The alternatives were worse: a
second command in the root `test` script changes what `pnpm test` means for
every package, and a separate CI job would leave `pnpm test`, the command
`AGENTS.md` holds every stage to, blind to the web app. The cost is that the
root run spawns the package's Vitest as a child process, as it already does
for the console.

**Everything in `pnpm test`, nothing beside it.** The parent design allows
"`pnpm test` or a job beside it". All eight checks are quick on a shell with
three screens, and a stage that runs `pnpm test` before it reports should
see the same result CI will. If the browser tests later grow past what the
suite can carry, moving them to a job of their own is a small spec; nothing
here stands in its way.

**`@playwright/test`, not `playwright-core` under Vitest.** The console
drives `playwright-core` from a Vitest file, which is enough for one
viewport test. The product app will have user flows (the editor, claiming a
board), and Playwright's own runner brings what those need: a web server it
starts and stops, a project per viewport, traces on failure. It is the same
library at the same version, with the same browser download, so nothing
already set up is replaced.

**Routes in code.** TanStack Router can also generate its route tree from
files under `src/routes/`. That directory is not an FSD layer, and the
generator adds a build plugin and a generated file to every check. A route
tree declared by hand in the `app` layer, with each page in `pages/`, is
equally type-safe and is what the console does. A later child that finds a
reason for file-based routes can change it; only `app/` would move.

**Zustand.** The product spec gives Zustand one job, editor state, and this
spec has no editor and no client state at all. knip, which is in the same
stack, fails a declared dependency that nothing imports, and a store written
only to have one would be code that exists for a list. So the catalog gains
`zustand`, which fixes the one version every package will use, the README
says where a store goes, and `layout-editor` declares the dependency with
the first store. The same reasoning does not apply to TanStack Query: its
provider belongs to the shell, and every later route assumes it is there.

**The TanStack versions move to the catalog.** The console declares the
router and the query library at ranges of its own. The catalog exists so
that one bump moves every UI package (spec 029 AC-6), and the product app is
the second user of both, so the ranges move there and the console's two
lines point at them. The lockfile resolves to the same versions as before.

**No panel in the shell.** The design's rule that geometry is configuration
binds this spec only as a rule for those who follow: the shell draws no
panel. AC-16 writes the rule where the next web child will read it.

## 5. Interfaces and files

The implementation's file scope:

- `web/` whole. Its files: `web/package.json`, `web/tsconfig.json`,
  `web/vite.config.ts`, `web/vitest.config.ts` (a sensitive path: it decides
  what the package's `test` script runs), `web/playwright.config.ts`,
  `web/steiger.config.ts`, `web/biome.json`, `web/knip.json`,
  `web/.gitignore`, `web/index.html`, `web/README.md`,
  `web/checks.test.ts`, `web/.storybook/`, `web/src/` (the `app` layer, the
  pages `home`, `not-found` and `error`, and `shared`), `web/e2e/`,
  `web/test/fixtures/fsd/`. `web/.gitkeep` is removed.
- `pnpm-workspace.yaml` (a sensitive path): the catalog entries of AC-1 and
  nothing else. The security review checks that the build-script approvals,
  the install-before-run setting and the existing catalog entries are as
  they were.
- `vitest.config.ts` at the repository root (a sensitive path): the one
  include entry of AC-14. The security review checks that no other test
  leaves the run.
- `console/package.json`: the two TanStack lines become `catalog:`.
- `pnpm-lock.yaml`; `README.md` at the root (one line).

Section 2 names what stays unchanged.

Interfaces the later web children build on:

- the scripts of AC-1, and the rule that a new kind of check is a new script
  with its own test in the checks file of AC-14;
- the route tree in the `app` layer, where a child adds its routes, and the
  frame every route is shown inside;
- the render helper of AC-11 and the three Playwright projects of AC-13;
- the token set in the app's stylesheet, extended only through a design;
- the import alias of AC-2 and the public-API rule of AC-3.

## 6. Verification

- `pnpm test` passes at the repository root, with the nine tests of
  `web/checks.test.ts` among those run; its output is in the
  implementation's final message.
- CI's `test` job passes on the implementation PR, and the PR's description
  quotes the lines of its log that show the web checks ran.
- Each check fails when it should: the steiger fixtures (AC-3) are tests;
  for the others the implementation's PR description records one deliberate
  break per check, made locally and reverted (a type error, an unformatted
  file, an unused export, a failing assertion, a story that throws, a
  browser test expecting the wrong heading), with the name of the test of
  `web/checks.test.ts` that failed.
- `pnpm -F @panelator/web dev` serves the app, and `/`, an unknown address
  and the Storybook catalogue (`pnpm -F @panelator/web storybook`) show the
  three screens as the design renders them; the review compares the source
  and stories with the design's renders at the three viewports (spec 098).
- The implementing machine needs the Chromium that `pnpm install` downloads
  through `@playwright/browser-chromium`, as the design stage's and the
  console's tests already do.

## 7. UI design

Screens: home, not-found, error

This is the product app's first design, so it fixes two things later web
children inherit: the frame and the token set. The design stage decides
both; what follows is what they must hold.

- **The frame.** A top band with the product's name, which is the link
  home, and the main region below it. Later children add primary navigation
  (boards, the editor) and an account control to this frame; the design
  shows where each will go at the three viewports and renders none of them,
  since no entry may lead nowhere (AC-7). The main region has a maximum
  reading width for text screens such as these three and can also be given
  the full width, which the editor and the simulator will need.
- **The tokens.** One set in `design/tokens.html`, extending the base tokens
  of `tools/design-stage/src/tokens.css`: colours, type scale, spacing,
  radii, breakpoints. It is the product's own set, not the console's. Light,
  dark or both is the design's choice; if both, each screen is rendered in
  each as a state.
- `home`: the frame, one heading, and a short statement of what panelator
  is, in the design's words, true to the product spec's section 1 (an
  open-source LED dashboard; a panel that renders on the board; a web app to
  build screens from widgets, preview them in a simulator and control the
  board). It states what exists, promises no date, and offers no action. No
  states.
- `not-found`: the frame, a heading, one line saying the address leads
  nowhere, and the link home. No states.
- `error`: the frame, a heading, one line saying something went wrong on
  this page, a reload control and the link home; no technical detail on the
  page (AC-9). No states.

Flow: `not-found` and `error` each lead to `home` by their link; the name
in the frame leads to `home` from every screen; `error`'s reload control
loads the current address again. `flow.md` records these, the frame's
breakpoints, the focus order and visible focus style, and the component
mapping (which parts are `shared/ui` components and which belong to a page).
The thresholds are the design stage's own: tap targets at least 44 CSS
pixels on mobile, text at least 14 CSS pixels, WCAG AA contrast.

## 8. Open decisions

None.
