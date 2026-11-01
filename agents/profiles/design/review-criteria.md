# Review criteria for design PRs (spec 029 AC-3)

1. Every screen named on the spec's `Screens:` line, and every state its UI design section names, is present as a
   story and rendered at all three viewports: `<screen>.png` (desktop 1440 by 900), `<screen>.mobile.png` (390 by
   844) and `<screen>.tablet.png` (820 by 1180), with `<screen>--<state>` and its two siblings for each state.
2. The layout holds at each viewport: no clipped or overlapping content, tap targets at least 44 CSS pixels on
   mobile, text at least 14 CSS pixels.
3. Text contrast meets WCAG AA.
4. The design follows the spec's UI design section and the parent design's decisions (for the console,
   delivery-system design section 9's direction A), and nothing the spec rules out.
5. One set of tokens is used throughout (the base tokens and the spec's `tokens.html`).
6. `flow.md` covers every transition the spec names.
7. The design decides UI and UX detail itself rather than deferring it to implementation.
8. Every PNG carries the renderer's `panelator-render` tEXt chunk, and its commit is on the PR; reject a PNG without
   it or with another commit, since only the renderer makes renders.
9. The PR changes nothing outside the spec's `design/` directory and its body closes no issue.
