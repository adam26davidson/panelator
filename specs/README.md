# specs/

One directory per feature: `specs/NNN-<slug>/spec.md`, numbered
sequentially, with design artifacts beside it in `design/` when the domain
is `web-ui` or `widget`. The required sections are defined in
[001-scheduler-core/spec.md](001-scheduler-core/spec.md) section 10:
status line with class, domain, `Parent:` and derives-from links; goal; out of scope;
numbered Given/When/Then acceptance criteria; interfaces and files;
verification; UI design where the domain needs it; open decisions, which
must be empty before the spec is eligible for the pipeline. A spec must
reference the design-tree or ADR entries it derives from.

The scheduler's gates enforce a few conventions on top of these sections.
The Open decisions section body must be empty or `None.` for the spec to be
eligible. A `web-ui` or `widget` spec's UI design section must carry a line
`Screens: <name>, <name>` naming each screen, and `design/` beside the spec
must hold a story (`*.stories.tsx`, `*.stories.jsx` or `*.stories.mdx`) or a
token prototype (`tokens*.html` or `*-prototype.html`) plus, for each named
screen, `<screen>.png` (desktop), `<screen>.mobile.png` and `<screen>.tablet.png`,
produced by the design stage's renderer (`pnpm -F @panelator/design-stage render <spec dir>`).
A missing design starts the design stage rather than parking the issue. The issue that carries a spec links it
with a body line `Spec: specs/NNN-slug/spec.md`. A spec split into a sub-design
keeps its directory with a `README.md` pointer and no `spec.md`, so its number
is not reused.

A spec derived from its parent design needs no maintainer approval of its
own (delivery-system design section 11, spec 006). Every spec carries a
`Parent:` line naming its parent design or top design, and that parent lists
the spec under its `## Children` heading; the spec-present gate and the
design-tree check in `pnpm test` enforce both.

Design hierarchy (delivery-system design section 10): every artifact has
exactly one parent, tracing up to `docs/charter.md`. A design is one document
type at any depth, lives in `docs/designs/<slug>.md` (the two top designs stay
where they are), and states its parent and lists its children. A design needs
at least two children; one child makes it a spec. Small work (bug, debt,
dependency and tooling specs) may name a top design as its parent directly.
A spec that would contradict its parent is a change to the parent first.
