# Review criteria for design PRs (spec 029 AC-3)

1. Every named screen and every state the spec's UI design section names is present, as a story and as a
   render at all three viewports: `mobile` 390x844, `tablet` 820x1180, `desktop` 1440x900.
2. The layout holds at each viewport: no clipped or overlapping content, tap targets at least 44 CSS pixels
   on mobile, text at least 14 CSS pixels.
3. Text contrast meets WCAG AA.
4. The design follows the spec's UI design section and the parent design's decisions (for the console,
   design section 9's direction A), and nothing the spec rules out.
5. One set of tokens is used throughout.
6. `flow.md` covers every transition between screens that the spec names.
7. The design decides UI and UX detail itself rather than deferring it to implementation.
8. Reject any PNG without the `panelator-render` tEXt chunk (the renderer writes it; check it with
   `readPngText` from `tools/design-stage/src/png-text.ts`, for example
   `node -e 'import("./tools/design-stage/src/png-text.ts").then(m=>console.log(m.readPngText(require("fs").readFileSync(process.argv[1]))))' <png>`).
9. The PR edits nothing outside `specs/NNN-<slug>/design/`.
