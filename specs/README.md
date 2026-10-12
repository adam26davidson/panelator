# specs/

One directory per feature: `specs/NNN-<slug>/spec.md`, numbered
sequentially, with design artifacts beside it in `design/` when the domain
is `web-ui` or `widget`. The required sections are defined in
[001-scheduler-core/spec.md](001-scheduler-core/spec.md) section 10:
status line with class, domain and derives-from links; goal; out of scope;
numbered Given/When/Then acceptance criteria; interfaces and files;
verification; UI design where the domain needs it; open decisions, which
must be empty before the spec is eligible for the pipeline. A spec must
reference the design-tree or ADR entries it derives from.

The scheduler's gates enforce a few conventions on top of these sections.
The Open decisions section body must be empty or `None.` for the spec to be
eligible. A `web-ui` or `widget` spec's UI design section must carry a line
`Screens: <name>, <name>` naming each screen, and `design/` beside the spec
must hold a story (`*.stories.tsx`, `*.stories.jsx` or `*.stories.mdx`) or a
token prototype (`tokens*.html` or `*-prototype.html`) plus a
`<screen>.png` for each named screen. The issue that carries a spec links it
with a body line `Spec: specs/NNN-slug/spec.md`.
