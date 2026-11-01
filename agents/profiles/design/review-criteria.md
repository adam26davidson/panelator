# Review criteria for design PRs (spec 029 AC-3)

Read the PNGs and the stories; judge only against these.

1. Every screen on the spec's `Screens:` line, and every state its UI design section names (as a story variant),
   is present at all three viewports: `<screen>.png` (desktop 1440 by 900), `<screen>.mobile.png` (390 by 844) and
   `<screen>.tablet.png` (820 by 1180), and `<screen>--<state>.png` with its two siblings for a state. Reject a PNG
   that lacks the `panelator-render` text chunk (the keyword is visible in the file's bytes): it was not made by
   the renderer.
2. The layout holds at each viewport: no clipped or overlapping content, tap targets at least 44 CSS pixels on
   mobile, text at least 14 CSS pixels.
3. Text contrast meets WCAG AA (4.5:1, or 3:1 for large text).
4. The design follows the spec's UI design section and the parent design's decisions (for the console, design
   section 9's direction A), and nothing the spec rules out.
5. One set of tokens is used throughout: colours, type scale, spacing, radii and breakpoints are the same across
   screens (and `tokens.html` records them when the components do not exist yet).
6. `flow.md` covers every transition between screens that the spec names, with the interaction notes.
7. The design decides UI and UX detail itself rather than deferring it to implementation: no "TBD", no "to be
   designed", no placeholder content standing in for a decision.
8. The PR changes nothing outside the spec's `design/` directory, and its body starts with `Refs #<issue>` and
   uses no closing keyword.
