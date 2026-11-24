# @panelator/web

The product's web app: React, Vite, TypeScript (strict), Feature-Sliced Design, Tailwind, TanStack Router and Query.
Spec 112 built the shell; nothing in it talks to a backend yet.

## Scripts

Run them with `pnpm -F @panelator/web <script>`. `pnpm test` at the repository root runs the checks marked ✓ through
`checks.test.ts`, one test per script, in this order.

| Script                  | What it does                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `dev`, `preview`        | the Vite dev server; a server for the production build                                                              |
| `typecheck` ✓           | `tsc --noEmit`, strict, over source, tests, stories, browser tests and config                                       |
| `lint` ✓                | Biome: formatting and the recommended rules                                                                         |
| `fsd` ✓                 | steiger's recommended rules on `src/`: import direction, public APIs, layer and segment names                       |
| `knip` ✓                | files, exports and dependencies nothing uses, in this package and in `simulator/`                                   |
| `simulator typecheck` ✓ | `pnpm -F @panelator/simulator typecheck`: the engine, strict                                                        |
| `simulator test` ✓      | `pnpm -F @panelator/simulator test`: builds the modules, then the engine's tests, with the golden frames under Node |
| `test` ✓                | Vitest in jsdom with Testing Library: `src/**/*.test.{ts,tsx}`, the steiger fixtures and every story                |
| `build` ✓               | the production build into `dist/`                                                                                   |
| `build-storybook` ✓     | the Storybook catalogue into `storybook-static/`; `storybook` serves it                                             |
| `e2e` ✓                 | Playwright against the production build, in the three viewports (mobile, tablet, desktop), on a free port           |

A new kind of check is a new script with its own test in `checks.test.ts`.

`dev`, `build`, `build-storybook` and `e2e` first build the widget modules with `sdk/rust/build-widgets.sh` (incremental).
So `pnpm test` needs the toolchain of `rust-toolchain.toml` with its `wasm32-unknown-unknown` target, and fails naming that
file without it. A passing `simulator test` and `e2e` print what they ran: one line per scene and per browser test, and
`module <file> sha256 <hex>` for each module.

## The simulator

`simulator/` is the workspace package `@panelator/simulator`: the engine that runs the identical WASM modules in the
browser, specified by `docs/widget-abi.md` (see its README). The app declares it as `workspace:*` and imports it only by
that name. The page `/simulator` (`src/pages/simulator/`) runs the three runtime-spike widgets live, as raw pixels; the
modules, the two fonts, the asset and the scene come from `target/widgets/` and `sdk/conformance/` and are served by
`vite.config.ts` under `/simulator-files/` (nothing is copied into `web/`). `e2e/conformance.spec.ts` runs the golden
frames in Chromium.

## Layers

`src/` holds FSD layers and nothing else; a layer imports only from layers below it, and a slice only through its
`index.ts`. Across layers and slices use the alias `@/` (for `src/`); inside a slice use relative imports.

- `app`: the entry, the providers, the router and the stylesheet. Routes are declared in code here.
- `pages`: one slice per screen (`home`, `not-found`, `error`).
- `widgets`, `features`, `entities`: created by the first child that has something for them.
- `shared`: `ui` (the frame, buttons and other pieces with no product knowledge), `lib`, `config`.

The simulator engine is shared code or its own package, never a feature slice (product spec 7).

State: a Zustand store lives in the `model` segment of the slice that owns the state, and is added with the first state
that needs one.

## Rules

- Tokens come from the design (`specs/112-web-app-skeleton/design/tokens.html`), carried by `src/app/styles.css`. No
  component uses a literal colour, font size, spacing, radius or breakpoint; extend the set only through a design.
- No file in `web/` hard-codes a panel's width, height or chain length: geometry is configuration (v0 build design).
