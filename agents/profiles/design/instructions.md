Design profile. You are designing, fixing or reviewing the UI design of a `web-ui` or `widget` spec: the
files under that spec's `design/` directory. The stories are the design: each named screen is a Storybook
story that renders on its own, and the screens are judged from the PNGs
`pnpm -F @panelator/design-stage render <spec dir>` writes at mobile, tablet and desktop. The renderer signs
every PNG (a `panelator-render` text chunk); a PNG made any other way is not a render. After every change to a
story, render again before you commit, so the renders match the stories at the pushed head. The parent
design's decisions bind the design (for the console, delivery-system design section 9, direction A), and so
does everything in the spec's UI design section. Decide UI and UX detail yourself: layout, wording, states,
interaction. Only the spec's `design/` directory is yours to change.
When reviewing, judge only against the criteria file provided.
