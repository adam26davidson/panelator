# 029. The design stage

Status: written 2026-11-01 for issue #38 as the first part of row E of the
delivery-system design's section 11 (the design stage; the console of design
section 9 is row E's second part and is its own spec, filed as its own issue,
blocked on this spec and on spec 022); specs derived from that design need no
maintainer approval (delivery-system design section 11). Needs spec 006 on
`main` (it is).
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 3 (UI and UX detail is decided by the design stage and its visual
review), 4 (`needs-design` becomes work for an agent), 6.3 (independent
reviewers), 9 ("Design first") and 11 (row E); [charter](../../docs/charter.md) ("Any UI
design for the system's own interface must involve a dedicated design stage
using design-specific tools and visual review by the model before
implementation can begin"); [design-tree](../../docs/design-tree.md) R5.Q4
(Storybook and Playwright are in the toolchain); [spec 001](../001-scheduler-core/spec.md)
section 10 item 7 (what the UI design section and `design/` hold);
[spec 006](../006-no-human-stops/spec.md) AC-4 (the spec track's shape, which
the design track mirrors), AC-20 (the park this spec replaces) and AC-21 (the
result contract shape); [spec 011](../011-asking-stage-keeps-its-work/spec.md)
and [spec 015](../015-chain-keeps-its-work/spec.md) (held work).

What the maintainer decided, kept as it is here: a dedicated design stage
with design tools and visual review before implementation; every screen
designed and reviewed at mobile, tablet and desktop; issues parked with
`needs-design-stage` are re-evaluated and the label removed.

## 1. Goal

Turn the park of spec 006 AC-20 into work. When a `web-ui` or `widget` spec
is on `main` without its design artifacts, the chain runs a **design stage**:
a strong-tier agent that, in the issue's worktree, writes the design as
Storybook stories (and a token prototype when the components do not exist
yet), renders every named screen at three viewports with the design package's
renderer, and opens a design PR. The PR is reviewed by an independent
reviewer with a design profile that reads the renders, goes through the
chain's fix loop as a code PR does, and merges. The UI-design gate then passes
on `main` and the chain plans the implementation from the merged design.

The design package `tools/design-stage/` is the "design-specific tools" of the
charter: a Storybook that catalogues `specs/*/design/*.stories.tsx`, a
renderer that drives it with Playwright at the three viewports, and the
shared tokens. It is the first user of design-tree R5.Q4's toolchain in the
repository.

## 2. Out of scope

- The console itself, its screens and hosting (row E's second part, the
  console spec, filed as its own issue with `blocked` until this spec and
  spec 022 have merged; its hosting shape is ADR 0005). The console is this
  stage's first job, not part of it.
- Designing the product's web app (`web/` is empty); the stage is ready for
  it when a `web-ui` spec for it exists.
- Changing what the design-tree check or the spec-present gate require; only
  the UI-design gate changes (AC-7).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review. `tools/scheduler/` and
  `agents/` are sensitive, so the security review runs on this PR.
- Playwright end-to-end tests of implemented screens: the renderer here
  screenshots stories, it does not test an app.
- A design "approval" by the maintainer: the design stage and its visual
  review decide UI and UX detail (design section 3). Product questions found
  while designing go through the question check as from any stage.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
A *UI spec* is a spec whose domain is `web-ui` or `widget`. *Named screens*
are the names on its `Screens:` line. *Viewports* are `mobile` 390 by 844,
`tablet` 820 by 1180, `desktop` 1440 by 900 CSS pixels at device scale 2,
listed once in `tools/design-stage/src/viewports.ts` *(agent's call: an
iPhone-class, an iPad-class and a laptop width)*.

**The stage and the track**

- AC-1. **A missing design starts the design stage.** Given a shortlisted
  issue whose UI spec on `main` fails the UI-design gate (AC-7), when it is
  claimed, then instead of spec 006 AC-20's park the chain runs the `design`
  stage with `track: "design"`, on branch `design-<issue>` created from
  `origin/main` in the issue's worktree, with stage input: the issue, the
  spec path, the gate's reason (which screens and files are missing), the
  viewports, and any earlier design attempts' review findings. Given the
  gate fails on `main` after a spec PR merges (spec 006's "merge, spec
  track" row), then the same happens in place of the park. `needs-design-stage`
  is applied by no code path any more. The stage definition
  `agents/stages/design.md` is strong tier, Claude harness, with bounds and a
  `profile: design` like `agents/stages/spec.md`.
- AC-2. **What the stage produces.** Given a design run, then it commits under
  `specs/NNN-<slug>/design/`: one `<screen>.stories.tsx` per named screen,
  each story a self-contained React component (it may import from the
  package it designs for only when that package exists on `main`; for
  components that do not exist yet the story carries its own markup and
  `tokens.html` records the tokens used: colours, type scale, spacing,
  radii, breakpoints); every state the spec's UI design section names as a
  story variant; `flow.md` with the flow between screens and the interaction
  notes; and the renders of AC-5. It pushes the branch and opens a PR whose
  body starts with `Refs #<issue>`, lists each screen with its three renders
  inline, and never uses a closing keyword. Its result validates against
  `design-result`: `verdict: designed` with `spec_path`, `pr_number`,
  `head_sha` and `screens: [{ name, stories, renders }]`, or
  `verdict: question` in the shape of spec 006 AC-21, plus `findings`. Given
  a result that names a screen with fewer than three renders, or a named
  screen with no story, then the stage fails as an invalid result.
- AC-3. **The visual review.** Given a design PR, then the review stage runs
  with profile `design` (`agents/profiles/design/`), on an independent
  reviewer (design section 6.3: a fresh session, the other vendor when quota
  allows, else the same Claude model), which reads the PNGs and the stories
  and judges only against `agents/profiles/design/review-criteria.md`: every
  named screen and state is present at all three viewports; the layout holds
  at each (no clipped or overlapping content, tap targets at least 44 CSS
  pixels on mobile, text at least 14 CSS pixels); contrast meets WCAG AA for
  text; the design follows the spec's UI design section and the parent
  design's decisions (for the console, design section 9's direction A) and
  nothing the spec rules out; one set of tokens is used throughout; the
  flow covers every transition the spec names; and the design decides UI
  and UX detail itself rather than deferring it to implementation. The
  result is spec 001's review result (`approve`, `request_changes` with
  findings, or `escalate` classified as spec 006 says). Given
  `request_changes`, then the chain's fix stage runs on the design PR with
  the findings, bounded by the existing fix bound, on the design stage's
  model, in the same worktree, and re-renders before pushing (AC-5).
- AC-4. **Merge and continue.** Given the design PR approved and
  `required_checks` green, then the chain merges it, deletes
  `design-<issue>`, re-reads the spec on `origin/main`, and given the
  UI-design gate now passes, runs `plan` with fresh stage counters and the
  issue's held work (specs 011 and 015) as after a spec-track merge. Given
  the gate still fails (a render missing on `main`), then the design stage
  runs again with the reason, counted against the design-revision bound.
  Given the bound is reached (chain configuration `bounds.design_revisions`,
  default 2, like the rescue and re-plan bounds of spec 006), then the issue
  follows spec 006's rescue path for a failed stage: the record goes to the
  spec agent in `revise` mode with the design attempts as history, on the
  theory that the spec's UI design section is unbuildable.

**The tools**

- AC-5. **The renderer makes the renders, never the agent.** `pnpm -F
  @panelator/design-stage render <spec dir> [--screen <name>]` builds the
  Storybook for that spec's `design/`, opens each named screen's default
  story with Playwright at each viewport, waits for fonts and images, and
  writes `<screen>.png` (desktop), `<screen>.mobile.png` and
  `<screen>.tablet.png` beside the stories; given a story variant for a
  state, `<screen>--<state>.png` and its two siblings as well. Given a story
  that throws or a screen with no story, then the command exits non-zero
  naming it. The command is the only way renders are produced: a test
  asserts that each PNG carries a `tEXt` chunk `panelator-render` with the
  viewport, story id and commit, and the design review criteria say to
  reject a PNG without it. The stage's instructions tell the agent to run
  it after every story change.
- AC-6. **The catalogue.** `pnpm -F @panelator/design-stage storybook` serves
  every `specs/*/design/*.stories.tsx` with Tailwind and the tokens of
  `tools/design-stage/src/tokens.css` (the base tokens; a spec's
  `tokens.html` extends them for its own prototype). `pnpm test` runs the
  package's vitest suite, which builds the Storybook for the fixture spec
  under `tools/design-stage/test/fixtures/` and renders it headless, so a
  toolchain break fails CI, not a design run. The package pins the
  toolchain of design-tree R5.Q4 (React, Vite, TypeScript strict, Biome,
  Tailwind, Vitest, Playwright, Storybook, knip) at versions `console/` and
  later `web/` reuse through the workspace catalog in
  `pnpm-workspace.yaml` *(agent's call: a catalog, so one bump moves all
  three)*.

**The gate and the parked issues**

- AC-7. **Three sizes in the gate.** `uiDesignGate` requires, for each named
  screen, `<screen>.png`, `<screen>.mobile.png` and `<screen>.tablet.png`,
  and a story or token prototype as today; its label constant and the "spec
  E will provide" text are removed, and its failure is a reason for AC-1,
  not a label. `specs/README.md` says the same in its UI paragraph. A spec
  whose `design/` was complete under the old rule (one PNG per screen) fails
  the new rule and gets the design stage for its two missing sizes; there
  is no such spec today.
- AC-8. **Parked issues are re-evaluated.** Given the service starts (or a
  tick runs) on code with this spec, then for every open issue labelled
  `needs-design-stage` it removes the label, posts one comment that the
  design stage now exists, and leaves the issue to the shortlist, which now
  claims it under AC-1. The label is removed once per issue, recorded in
  the state directory so a restart does not comment twice. Given no such
  issue (true at the time of writing), then nothing happens.
- AC-9. **Everything else is unchanged.** Given a spec with a non-UI domain,
  then no behaviour of this spec runs: the recorded chains of specs 006,
  007, 008, 011, 013, 015 and 025 pass unchanged.

## 4. Design notes (agent's calls)

- **A chain stage, not a standing agent.** The design belongs to one issue
  and sits between its spec and its plan, exactly where the spec stage
  sits; it reuses the spec track's branch, PR, review, fix and merge
  machinery with a different profile, so the new code is the stage prompt,
  the profile, one track value and the gate change.
- **Stories are the design.** The charter wants design-specific tools and
  visual review by the model. A Storybook story is a design artifact a model
  can write, render, read back as pixels and diff; a Figma file is not
  reachable from a shell. Rendering at three viewports is what "designed and
  reviewed at mobile, tablet and desktop" means in code.
- **The renderer signs its output** (the `tEXt` chunk) so a reviewer can tell
  a rendered screen from a pasted image, and the commit it was rendered at.
- **The review is a profile of the review stage,** not a fourth reviewer, so
  the independent-reviewer rule, the fix loop and the merge are the ones
  already tested.
- **What the console spec relies on from here.** The console is a `web-ui`
  spec, so it cannot pass the UI-design gate until this stage has produced
  its `design/`; it names its screens on its `Screens:` line and nothing
  else about their look, and the stage fills its `design/` with the
  artifacts of AC-2 and AC-5. Its package reuses the toolchain catalog of
  AC-6. Row E was expected to become a sub-design with these two children
  (design section 10); the spec PR scope of spec 006 AC-21 cannot add a
  sub-design and a sibling spec in the PR of one spec, so the two parts hang
  from the top design directly, and the order between them is carried by the
  `blocked` label as in the metrics and reflection split (ADR 0004).

## 5. Interfaces and files

- `agents/stages/design.md` (the stage definition and prompt: the artifacts
  of AC-2, run the renderer, open the PR, the result shape, the question
  rules of the spec stage). `agents/profiles/design/`: `profile.yaml`,
  `instructions.md`, `review-criteria.md` (AC-3).
- `schemas/scheduler/design-result.json` (AC-2); `schemas/scheduler/stage-input.json`
  gains the design fields of AC-1.
- `tools/scheduler/src/chain/types.ts`: stage `design`, track `design`,
  `bounds.design_revisions`; `tools/scheduler/src/chain/machine.ts`: the
  claim and post-merge paths of AC-1, the design PR's review, fix and merge
  of AC-3 and AC-4; `tools/scheduler/src/gates/ui-design.ts` (AC-7);
  `tools/scheduler/src/service/loop.ts`: the re-evaluation of AC-8;
  `tools/scheduler/src/state/paths.ts`: `design/relabelled.json` (AC-8);
  `agents/scheduler.yaml`: `bounds.design_revisions`.
- `tools/design-stage/`: `package.json` (`@panelator/design-stage`, scripts
  `storybook`, `render`, `test`), `.storybook/` (config globbing
  `../../specs/*/design/*.stories.tsx`), `src/viewports.ts`,
  `src/tokens.css`, `src/render.ts` (AC-5), `test/` with a fixture spec
  directory (AC-6). Root `package.json` and `pnpm-workspace.yaml`: the new
  workspace package and the toolchain catalog.
- `specs/README.md`: the three renders per screen (AC-7).
- `tools/scheduler/test/`: `ui-design.test.ts` (AC-7), `machine.test.ts`
  (AC-1, AC-3, AC-4), `loop.test.ts` (AC-8), recorded runs of section 6 in
  `e2e.test.ts`. `tools/README.md`: the design package and the stage.

No file outside `tools/`, `agents/`, `schemas/scheduler/`, `specs/README.md`,
`package.json`, `pnpm-workspace.yaml` and `dev-logs/` is changed by the
implementation. `tools/scheduler/`, `agents/`, `package.json` and
`pnpm-workspace.yaml` are sensitive paths, so the security review runs on the
PR as spec 006 AC-9 says.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including recorded end-to-end runs (fake adapter, mocked GitHub) for:
  - a UI spec without `design/`, shortlisted: the design stage runs on
    `design-<issue>`, no `needs-design-stage` label (AC-1);
  - a design result missing a render: invalid result (AC-2);
  - a design PR with `request_changes`: the fix stage on the design PR, then
    approve, merge, gate passes, `plan` runs with held work (AC-3, AC-4);
  - the gate still failing after the merge twice: the spec agent in `revise`
    mode (AC-4);
  - an issue labelled `needs-design-stage` at start: label removed, one
    comment, a restart comments nothing (AC-8);
  - every earlier recorded chain unchanged (AC-9).
- The design package's own suite renders the fixture spec at three
  viewports and checks the `panelator-render` chunk (AC-5, AC-6).
- After the merge, the first real design run is the console's (row E's
  second part); its PR and renders are written up in `dev-logs/`.

## 7. Open decisions

None.
