# @panelator/web

The product's web app: React, Vite, TypeScript (strict), Feature-Sliced Design, Tailwind, TanStack Router and Query.
Spec 112 built the shell; nothing in it talks to a backend yet.

## Scripts

Run them with `pnpm -F @panelator/web <script>`. `pnpm test` at the repository root runs the checks marked ✓ through
`checks.test.ts`, one test per script, in this order.

| Script | What it does |
|---|---|
| `dev`, `preview` | the Vite dev server; a server for the production build |
| `typecheck` ✓ | `tsc --noEmit`, strict, over source, tests, stories, browser tests and config |
| `lint` ✓ | Biome: formatting and the recommended rules |
| `fsd` ✓ | steiger's recommended rules on `src/`: import direction, public APIs, layer and segment names |
| `knip` ✓ | files, exports and dependencies nothing uses |
| `test` ✓ | Vitest in jsdom with Testing Library: `src/**/*.test.{ts,tsx}`, the steiger fixtures and every story |
| `build` ✓ | the production build into `dist/` |
| `build-storybook` ✓ | the Storybook catalogue into `storybook-static/`; `storybook` serves it |
| `e2e` ✓ | Playwright against the production build, in the three viewports (mobile, tablet, desktop), on a free port |

A new kind of check is a new script with its own test in `checks.test.ts`.

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
