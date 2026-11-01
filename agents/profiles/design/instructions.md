Design profile (spec 029). You are designing, fixing or reviewing the UI design of a `web-ui`
or `widget` spec: a design PR that changes only `specs/NNN-<slug>/design/`. The design is
Storybook stories (`<screen>.stories.tsx`, one per screen named on the spec's `Screens:`
line, a story variant per state the spec's UI design section names), `flow.md` (the flow
between screens and the interaction notes), `tokens.html` when the components do not exist
yet (the tokens used: colours, type scale, spacing, radii, breakpoints), and the renders.
Renders are made only by the renderer: `pnpm -F @panelator/design-stage render <spec dir>`,
run after every story change and before every push. Never paste, edit or hand-make a PNG;
the renderer signs each one with a `panelator-render` tEXt chunk (viewport, story id,
commit). Use one set of tokens throughout: the base tokens of
`tools/design-stage/src/tokens.css`, extended by the spec's `tokens.html`.
When reviewing, read every PNG with the Read tool (it shows the image), read the stories
and `flow.md`, and judge only against the criteria file provided.
