Design profile. You are designing, fixing or reviewing the UI design of a `web-ui` or
`widget` spec: the files under the spec's `design/` directory, `specs/NNN-<slug>/design/`,
and nothing else. The design is Storybook stories, rendered to PNGs by the design
package; the design package's renderer is the only way a PNG is made.

- Artifacts: one `<screen>.stories.tsx` per screen named on the spec's `Screens:` line, each a
  self-contained React component (import from the package the spec designs for only when it
  exists on `main`; otherwise the story carries its own markup and `tokens.html` records the
  tokens used: colours, type scale, spacing, radii, breakpoints). Every state the spec's UI design
  section names is a story variant of its screen. `flow.md` holds the flow between screens and the
  interaction notes. Use one token set throughout; the base tokens are `tools/design-stage/src/tokens.css`.
- Viewports: every screen is rendered at `mobile` 390 by 844, `tablet` 820 by 1180 and `desktop`
  1440 by 900 CSS pixels at device scale 2.
- Render after every story change, from the repository root, and again before any push:
  `pnpm -F @panelator/design-stage render specs/NNN-<slug>` (add `--screen <name>` for one
  screen). It writes `<screen>.png` (desktop), `<screen>.mobile.png`, `<screen>.tablet.png` and
  `<screen>--<state>.png` with its two siblings for each state. Never draw, paste or edit a PNG:
  each carries a `panelator-render` tEXt chunk the renderer writes.
- Scope: the diff touches files under `specs/NNN-<slug>/design/` only.
- The PR body starts with `Refs #<issue>` and never uses a closing keyword (`Closes`, `Fixes`, `Resolves`).
- UI and UX detail is decided here, by you, not deferred to implementation. Product questions go
  through the question rules of the stage prompt.
When reviewing, read the PNGs and the stories, and judge only against the criteria file provided.
