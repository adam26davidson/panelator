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
