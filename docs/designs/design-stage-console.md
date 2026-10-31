# Design stage and maintainer console

Status: written 2026-11-01 for issue #38; row E of the delivery-system design's
section 11 is this design, which section 10 of that design already expects to
be a sub-design with two children (the design stage, then the console). Its
children are built in the order listed under `## Children`.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../delivery-system-design.md) sections 3
(UI and UX detail is the design stage's), 4 (`needs-design` becomes work for an
agent), 6.2 (console exposure of new agents, parameters and metrics), 6.3
(independent reviewers), 8 ("AWS for the delivery system"), 9 ("The console"),
11 (row E) and 13; [charter](../charter.md) (the interface, the dedicated
design stage with design-specific tools and visual review, auto and locked
parameters, the interface kept up to date and improved over time);
[design-tree](../design-tree.md) R5.Q4 (the front-end toolchain);
[spec 006](../../specs/006-no-human-stops/spec.md) AC-20 (`needs-design-stage`);
[spec 022](../../specs/022-delivery-aws-account/spec.md) (the account the
console lives in); [ADR 0005](../decisions/0005-console-static-site-small-api.md)
(the console's hosting shape); [ADR 0004](../decisions/0004-split-metrics-reflection-spec.md)
(why one issue of this size is split into one spec per PR).

## 1. Intent

Two things the charter asks for and nothing yet provides: a design stage, so
that any user interface the system builds for itself is designed with design
tools and reviewed visually before a line of implementation; and the console,
the maintainer's secure, mobile-friendly, hosted view of delivery and control
over the system's parameters. The console is the design stage's first job
(design section 9, "Design first"), so the stage is built first and the
console's own design artifacts are its first output.

## 2. What the maintainer decided

Recorded on issue #38, quoted as written there:

> Maintainer decisions: home screen direction 'A' (questions banner, one large card for the current issue with stage progress, up next, four stat tiles: merged per week, median issue-to-merge, rework, AWS spend against the cap); every screen designed and reviewed at mobile, tablet and desktop; a dedicated design stage with design tools and visual review before implementation; parameters each with an auto/locked switch; sign-in only for the maintainer's GitHub login; nothing connects in to the laptop (scheduler pushes state, pulls changes); a delivery-system package separate from `web/` reusing its React toolchain. Re-evaluate issues parked with `needs-design-stage` and remove the label.

And, from the same issue, what only the maintainer can do:

> What only the maintainer can do: create the GitHub OAuth app for sign-in, and choose a domain if one is wanted. Raise these as capability questions when needed.

Design section 9 carries the same decisions with the author's calls on the
other screens, the starting parameters, hosting and access, and the package.
This design changes none of them, nor any statement design section 5
protects. Mockup A is the design stage's input, not its output (section 9):
the console spec here fixes what each screen holds and the stage decides how
it looks.

## 3. The split

| Order | Spec | Delivers | Readers it serves |
|---|---|---|---|
| 1 | 029 Design stage | the `design` chain stage, the design workspace package (Storybook catalogue, three-viewport renderer), the visual review profile, the three-size rule in the UI-design gate, the re-evaluation of `needs-design-stage` issues | every `web-ui` and `widget` spec, starting with 030 |
| 2 | 030 Maintainer console | the `console/` package, its hosting in the delivery account, GitHub sign-in for one login, the scheduler's state push and change pull, the six screens | the maintainer |

**The order is carried by the `blocked` label**, as in the metrics and
reflection design. Issue #38 carries spec 029. The console's issue is filed
with `Spec: specs/030-console/spec.md` and `blocked`, and loses the label when
both spec 029 and spec 022 (F1) have merged: 029 because the console is a
`web-ui` spec and cannot pass the UI-design gate until the stage has produced
its `design/`; 022 because the console is hosted in the delivery account and
is never hosted elsewhere (issue #38). Until the console issue exists, the
finding filed with this design's PR asks for it (issue #41 is the general
mechanism for a merged design's children).

Each child merges on its own and leaves `main` working:

- **029 changes the chain only where the chain parks today.** The one code
  path it replaces is spec 006 AC-20's park on a missing design. Every spec
  with a non-UI domain is untouched by it.
- **030 adds a package and a push and a pull.** With no console configured
  (no `console` block in `agents/scheduler.yaml`) the scheduler runs exactly
  as before; with AWS off (spec 022 AC-2) nothing is deployed and the stage
  says so instead of hosting the console anywhere else.

### Contracts between the children

- **The design artifacts.** 029 defines what a finished design is: in
  `specs/NNN-<slug>/design/`, one story file per screen, a `tokens.html`
  prototype when the components do not exist yet, and for each screen named
  on the spec's `Screens:` line three renders, `<screen>.png` (desktop),
  `<screen>.mobile.png` and `<screen>.tablet.png`, produced by the stage's
  renderer, never by hand. The UI-design gate requires all three. 030's spec
  names its screens and nothing else about their look; the stage fills
  `specs/030-console/design/`.
- **The console renders from data, so it keeps up.** 030 reads agents,
  parameters, metrics and actions from the pushed state as lists and shows
  whatever is there. A PR that adds an agent, a parameter or a metric
  (design 6.2) therefore needs no console change unless it wants a bespoke
  view; that is the "console exposure" such a PR includes.
- **One front-end toolchain.** Design-tree R5.Q4 fixes it: React, Vite,
  TypeScript strict, Biome, Tailwind, Vitest, Playwright, Storybook, knip.
  `web/` is empty today, so 029's design package is the first user of that
  toolchain in the repository and 030's `console/` the second; when `web/`
  is created it joins the same versions. The design package renders stories
  for any spec, product or system, from `specs/*/design/`.
- **What the scheduler already has.** 030 consumes, and does not redefine:
  the parameter store and actions of spec 008 (`setParameter`,
  `setParameterMode`, the action log and `undo`, `pause_agent` and
  `resume_agent`, actor `maintainer`); the questions log of specs 006 and
  007; the metrics report of spec 027; `aws/cost.json` and `reserveSpend` of
  spec 022; the run and claim records of spec 001.

## 4. What this design leaves to its children

Everything the top design's section 13 left to the builder for row E: the
console's stack details within the toolchain (ADR 0005 fixes the hosting
shape; the spec fixes the rest), how state is pushed and changes pulled, the
viewports, the review criteria for a design, and the design-revision bound.

## Children

- `specs/029-design-stage/spec.md`
- `specs/030-console/spec.md`
