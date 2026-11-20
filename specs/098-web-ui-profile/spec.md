# 098. The web-ui profile: implement, fix and review instructions for UI packages

Status: written 2026-11-20 from the delivery-system design for issue #206
(the planned child `web-ui-profile`); specs derived from that design need no
maintainer approval (design section 11). Marks no earlier spec: spec 001
section 9 already says the `web-ui` profile is "filled by its own spec", and
this is that spec.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops: a stage must be told every rule it
is held to, because nobody answers while it runs) and section 9 (the
console's design direction, which a UI review judges against);
[001-scheduler-core](../001-scheduler-core/spec.md) section 9 (a profile is
`profile.yaml`, `instructions.md` and `skills/`; review for a domain uses the
same profile as implement "so UI review judges against the design
artifacts"; `web-ui` is a v0 profile name filled by its own spec) and section
10 (the UI design section: flow, one artifact per screen and state, component
mapping, interaction notes, all under `design/`);
[029-design-stage](../029-design-stage/spec.md) AC-2 (what a design run
produces: stories, `tokens.html`, `flow.md`, the renders), AC-3 (the design
review criteria, whose thresholds this profile's review reuses), AC-5 (the
three viewports and the `panelator-render` chunk) and AC-6 (the toolchain
catalog in `pnpm-workspace.yaml` that `console/` and `web/` reuse);
[017-read-only-stages-not-told-to-run-tests](../017-read-only-stages-not-told-to-run-tests/spec.md)
AC-1 and AC-3 (the conditional `pnpm test` sentence and the guard test that
holds every profile to it);
[046-agents-md-conditions-pnpm-test-on-a-shell](../046-agents-md-conditions-pnpm-test-on-a-shell/spec.md)
(the same rule in `AGENTS.md`);
[077-plan-names-its-implementation-profiles](../077-plan-names-its-implementation-profiles/spec.md)
AC-1 to AC-4 (the plan prompt names the domains with an implementation
profile, the I4 check accepts only those, and a test holds the sentence to the
profile directory, so a new implementation profile adds its name there);
[051-console](../051-console/spec.md) section 4 ("Prerequisites": the console
waits for this profile rather than being reclassified `backend`, because the
backend profile carries no UI review criteria);
[design-tree](../../docs/design-tree.md) R5.Q4 (the frontend toolchain: React,
Vite, TypeScript strict, Biome, Tailwind, Vitest, Playwright, Storybook, knip).

## 1. Goal

A `web-ui` issue can run the chain. Today the plan stage classifies UI work
as `web-ui` (spec 077 AC-1 maps `web/` to it, and spec 051's console is a
`web-ui` spec), and the chain driver then fails the plan with
`profile not available: web-ui (implementation profiles: backend)` because
`agents/profiles/web-ui/` does not exist (the I4 check in
`tools/scheduler/src/chain/driver.ts`). That is what holds the console (spec
051, row E of the delivery-system design) behind the `blocked` label.

After this spec, `agents/profiles/web-ui/` exists with:

- `profile.yaml`: name `web-ui`, the shell tools of the backend profile, no
  credential hook, and `review_criteria: review-criteria.md`;
- `instructions.md`: the rules for TypeScript and React packages built on the
  toolchain catalog of spec 029 AC-6; the spec's merged `design/` as the
  reference the implementation follows, through its tokens and the component
  mapping and interaction notes in `design/flow.md`; the conditional
  `pnpm test` sentence of specs 017 and 046; the file-scope and findings rules
  of the backend profile;
- `review-criteria.md`: the implementation matches the design's renders at
  mobile 390x844, tablet 820x1180 and desktop 1440x900; every screen state the
  spec's UI design section names is built and tested; tap targets at least 44
  CSS pixels on mobile; WCAG AA contrast; the design's tokens used throughout;
- `skills/` with a `.gitkeep`, empty, as the other profiles' are.

The profile list test (`tools/scheduler/test/profiles.test.ts`) and the two
other tests that spell out the implementation profiles are updated, and the
plan prompt's sentence naming the domains with an implementation profile gains
`web-ui`, which spec 077 AC-4's test requires of every new implementation
profile.

**Why the plan prompt changes here.** *(agent's call)* The issue body, filed
from the design's brief as it stood on 2026-11-18, leaves "the plan prompt's
list of offered domains (issue #145)" to its own work. Issue #145 is spec 077,
which has since merged: it rewrote that list and left one sentence,
"The domains with an implementation profile today are: `` `backend` ``.",
whose test reads the profile directory and fails `pnpm test` the moment a second
implementation profile is added without the name in that sentence. Spec 077
section 4 added the clause to this child's brief in the parent design for
exactly that reason. So the one-word addition is part of making this spec
buildable (a PR must pass `pnpm test`, AGENTS.md), and it does the work of
issue #145 in no other way: the domains offered, their areas and the
`profile not available` paragraph stay as spec 077 AC-1 fixed them.

**How a reviewer without a shell judges a UI.** *(agent's call)* The review
stage has no shell (spec 017 AC-2), so it cannot build the package or render
it. The criteria therefore name what a reader can check: the design's renders
under the spec's `design/` (PNGs the review's Read tool opens), the stories
beside them, the implementation's source, its stylesheet and its tests. A
design render is the reference; the review never asks for a render of the
implementation and treats a screenshot the PR description claims as a claim,
as spec 080 has it. What a reviewer cannot read it reports in
`declined_to_judge`, which the stage prompt already provides for.

## 2. Out of scope

- The `widget`, `firmware` and `infra` profiles: each is its own spec's work
  (spec 001 section 9). The plan prompt's sentence still names only the
  profiles that exist.
- The plan prompt's list of offered domains, their areas and the
  `profile not available` paragraph (spec 077 AC-1): unchanged apart from the
  one name added to the implementation-profile sentence (AC-5).
- A skill under `agents/profiles/web-ui/skills/`: the directory ships empty
  (a `.gitkeep`), as `backend`, `design`, `security` and `spec` do today. A
  UX skill in Agent Skills format can be added by a later spec once a UI has
  been built under this profile and the recurring guidance is known.
- The design stage, its profile, its review criteria and its renderer (spec
  029): unchanged. This profile reuses the design's thresholds; it does not
  restate how a design is made.
- Any change to `pickProfile`, the I4 check, the security-review selection,
  `STAGE_PROFILES` or `implementationProfiles` in
  `tools/scheduler/src/profiles/resolve.ts`: the code already lists whatever
  directories exist. Only the directory and the tests that spell out its
  contents change.
- Test wiring for a UI package (the root `vitest.config.ts` already includes
  `web/**/*.test.ts`; a package elsewhere, such as spec 051's `console/`, is
  that spec's concern).
- Which tools a stage may use: the `tools` list copies the backend profile's
  and the adapters' read-only rule for plan and review (spec 017 section 2)
  is untouched.

## 3. Acceptance criteria

- AC-1. **The profile exists and resolves.** Given `agents/profiles/web-ui/`
  on `main`, when `resolveProfile(agentsDir, "web-ui")` runs, then it returns
  a profile whose `tools` are exactly `[Read, Edit, Write, Bash, Glob, Grep]`
  (the backend profile's list, in its order), whose `credentialHook` is
  undefined (`credential_hook: null` in the file), whose `reviewCriteria` is
  the text of `agents/profiles/web-ui/review-criteria.md`, whose
  `instructions` is the text of `agents/profiles/web-ui/instructions.md`, and
  whose `skillsDir` is `agents/profiles/web-ui/skills`, a committed directory
  holding `.gitkeep`. `profile.yaml` reads, word for word:

  ```yaml
  name: web-ui
  tools: [Read, Edit, Write, Bash, Glob, Grep]
  credential_hook: null
  review_criteria: review-criteria.md
  ```

  Given a plan result with `domain: web-ui` and no `escalation`, when the
  chain driver handles the plan stage's result, then the I4 check passes
  (`implementationProfiles(agentsDir)` now includes `web-ui`), and the
  implement, fix and review stages of that issue run under this profile:
  their prompts' `profile_instructions` is `instructions.md` followed by a
  blank line and `review-criteria.md`, as `tools/scheduler/src/runner/run.ts`
  joins them for every profile with criteria.

- AC-2. **The instructions.** Given `agents/profiles/web-ui/instructions.md`,
  when it is read, then it is this text, word for word (line breaks may
  differ):

  > Web-ui profile. TypeScript and React packages of the pnpm workspace that
  > run in a browser: `web/`, `console/` once it exists, and any other package
  > the spec names. Build on the workspace toolchain catalog (`catalog:` in
  > `pnpm-workspace.yaml`, spec 029 AC-6: React, Vite, TypeScript strict,
  > Biome, Tailwind, Vitest, Playwright, Storybook, knip): declare each of
  > these dependencies as `catalog:` and pin no version of your own, so one
  > bump moves every UI package. A dependency outside the catalog is a
  > finding in your result unless the spec's Interfaces section names it.
  >
  > The spec's merged `design/` directory (`specs/NNN-<slug>/design/`) is the
  > reference the implementation follows, not a suggestion: its stories are
  > the component structure and copy of each screen and state, its renders
  > (`<screen>.png` for desktop 1440 by 900, `<screen>.mobile.png` for 390 by
  > 844, `<screen>.tablet.png` for 820 by 1180, and `<screen>--<state>` with
  > the same three sizes for each state) are what each viewport looks like,
  > `tokens.html` (extending `tools/design-stage/src/tokens.css`) is the one
  > token set, and `flow.md` holds the navigation, the transitions, the
  > interaction notes and the component mapping. Put the tokens into the
  > package's stylesheet as the same custom properties and use them
  > throughout; a literal colour, size, radius or breakpoint outside the set
  > is a defect. Build every screen on the spec's `Screens:` line and every
  > state its UI design section names, and give each state a test that
  > renders it; exercise the mobile, tablet and desktop layouts in tests at
  > the design's viewport widths. Where the design is silent, follow the
  > nearest render and record the gap as a finding; do not redesign. UI and
  > UX detail was decided by the design stage: a change to it is a design
  > PR, not an implementation choice. Product questions go through the
  > question rules of the stage prompt.
  >
  > When your stage has a shell (implement and fix), run `pnpm test` from the
  > repo root before writing your result, and the package's own `typecheck`
  > and `lint` scripts when it has them. A stage without a shell (plan and
  > review) judges by reading: do not try to run the suite, and a command you
  > could not run is not a missing verification. Do not touch files outside
  > the plan's file scope; lockfiles and `schemas/` are the only exceptions.
  > Record anything you notice but must not fix as a finding in your result,
  > then continue with your task.

  So spec 017 AC-3's guard test passes: the one sentence containing
  `pnpm test` contains `shell`, and no other sentence names the suite.

- AC-3. **The review criteria.** Given
  `agents/profiles/web-ui/review-criteria.md`, when it is read, then it is
  this text, word for word (line breaks may differ):

  > # Review criteria for web-ui implementation PRs (spec 098 AC-3)
  >
  > The reference is the spec's merged `design/`: read its renders (the PNGs,
  > with Read) and stories, then the implementation's source, stylesheet and
  > tests. You have no shell and render nothing; a screenshot or a measurement
  > the PR description claims is a claim, not evidence. Judge from what you
  > can read, and name what you could not judge in `declined_to_judge`.
  >
  > 1. The implementation matches the design's renders at all three
  >    viewports: `mobile` 390x844, `tablet` 820x1180, `desktop` 1440x900.
  >    For every named screen and state, the components, their arrangement
  >    and order, the copy, and the breakpoints at which the layout changes
  >    correspond to the story and its three renders; nothing is clipped or
  >    overlapping at any of the three widths.
  > 2. Every screen on the spec's `Screens:` line and every state the spec's
  >    UI design section names is built, and each state has a test that
  >    renders it; the mobile, tablet and desktop layouts are each exercised
  >    by at least one test at that viewport width.
  > 3. Tap targets are at least 44 CSS pixels on mobile, and text is at least
  >    14 CSS pixels, as the design was held to.
  > 4. Text contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text),
  >    using the design's tokens; a token pair the design already passed is
  >    not re-measured, a colour outside the set is checked.
  > 5. The design's tokens are used throughout: the package's stylesheet
  >    carries the token set of `design/tokens.html` (or the base
  >    `tools/design-stage/src/tokens.css` when the design added none) as the
  >    same custom properties, and no component uses a literal colour, size,
  >    radius or breakpoint outside it.
  > 6. The navigation, transitions and interaction notes of `design/flow.md`
  >    are implemented, and every transition the spec names reaches the
  >    screen the design says.
  > 7. Toolchain dependencies are declared as `catalog:` from
  >    `pnpm-workspace.yaml`; a dependency outside the catalog is named in the
  >    spec's Interfaces section.
  > 8. The PR edits nothing outside the plan's file scope (lockfiles and
  >    `schemas/` excepted) and changes nothing under the spec's `design/`: a
  >    UI or UX change is a design PR.
  >
  > Judge only against these criteria and the spec's acceptance criteria.
  > Every finding cites the criterion, the screen and state, the viewport
  > where it applies, and the file and line.

  The thresholds of criteria 1 to 4 are the design review's (spec 029 AC-3
  criteria 1 to 3), so an implementation is held to what its design passed.

- AC-4. **The tests name the new profile.** Given `pnpm test`, then:
  - `tools/scheduler/test/profiles.test.ts` expects `listProfiles(agentsDir)`
    to equal `["backend", "design", "security", "spec", "web-ui"]` and
    `implementationProfiles(agentsDir)` to equal `["backend", "web-ui"]`;
  - the same file has a test `resolves web-ui with the UI review criteria
    (spec 098 AC-3)` that resolves `web-ui`, expects `tools` to equal the
    backend profile's `tools`, `credentialHook` to be undefined, and the
    review criteria to contain each of `390x844`, `820x1180`, `1440x900`,
    `44 CSS pixels`, `14 CSS pixels`, `WCAG AA`, `tokens.html`, `flow.md` and
    `catalog:`; and the instructions to contain `design/`, `flow.md`,
    `catalog:` and `pnpm test`;
  - the existing guard tests of that file hold without change: every profile
    has a committed `skills/.gitkeep`, and no `pnpm test` sentence lacks
    `shell` (spec 017 AC-3);
  - `tools/scheduler/test/driver.test.ts`'s test "fails a plan whose domain
    names a profile that does not exist" expects the history entry
    `profile not available: firmware (implementation profiles: backend, web-ui)`;
  - `tools/scheduler/test/stages.test.ts`'s test of spec 077 AC-4 passes
    unchanged, because AC-5's sentence lists exactly
    `implementationProfiles(agentsDir)`.

- AC-5. **The plan prompt names the new profile.** Given
  `agents/stages/plan.md` after this change, then the sentence
  "The domains with an implementation profile today are: `` `backend` ``."
  reads "The domains with an implementation profile today are:
  `` `backend` ``, `` `web-ui` ``." and nothing else in the file changes.

- AC-6. **Nothing else changes.** Given the implementation PR, then it edits
  only the files of section 4; no stage definition frontmatter, gate, bound,
  label rule, other profile, sensitive-path list, security criterion or
  review criteria of another profile changes; and `git diff main -- agents/stages/plan.md`
  touches only the line of AC-5.

## 4. Interfaces and files

No schema, config key, state file or event changes. The implementation PR
adds or edits:

- `agents/profiles/web-ui/profile.yaml`: the four lines of AC-1.
- `agents/profiles/web-ui/instructions.md`: the text of AC-2.
- `agents/profiles/web-ui/review-criteria.md`: the text of AC-3.
- `agents/profiles/web-ui/skills/.gitkeep`: empty.
- `agents/stages/plan.md`: the one name of AC-5.
- `tools/scheduler/test/profiles.test.ts`: the list assertions and the new
  test of AC-4.
- `tools/scheduler/test/driver.test.ts`: the reason string of AC-4.

The spec PR itself adds this file and replaces the planned child
`web-ui-profile` under `## Children` in `docs/delivery-system-design.md` with
this spec's path.

`agents/` and `tools/scheduler/` are sensitive paths
(`agents/sensitive-paths.txt`), so the security review applies to the
implementation PR (spec 006 AC-9). The paths the implementation touches under
them are the seven listed above, named here so the scope gate accepts the
diff. The change adds a profile directory whose tool allowlist copies the
backend profile's (no new tool, hook or permission), adds one name to a
prompt sentence that a test already ties to the profile directory, and
updates three test expectations to the longer profile list; it adds no
network listener, outbound call or shell execution beyond what the backend
profile already allows, and it does not touch `pickProfile`, the I4 check,
`isSensitive`, `securityPass`, the sensitive-path list, the two-review rule,
the listed-in-the-spec rule, any bound or label rule, and it drops, skips or
narrows nothing `pnpm test` runs (security criteria 3, 5 and 10). This spec
plans no change to the charter, to a protected maintainer decision, to the
security review criteria or instructions, or to what decides that a sensitive
diff gets the security review, that both reviews must approve, or that a
sensitive path must be listed in the spec.

## 5. Verification

- AC-1: `cat agents/profiles/web-ui/profile.yaml` prints the four lines;
  `ls agents/profiles/web-ui/skills/.gitkeep` succeeds; the profiles test of
  AC-4 passes. Live: the next plan for issue #101 (the console) with
  `domain: web-ui` is not failed with `profile not available`, and its
  implement run's prompt carries the instructions and criteria (visible in
  the run's events under the state directory).
- AC-2, AC-3: read the two files on the PR branch; the text is the quoted
  text with whitespace collapsed. The spec 017 AC-3 guard test and the new
  test of AC-4 pass.
- AC-4, AC-5: `pnpm test` from the repository root passes, including the
  updated and new tests; `grep -c 'today are: `backend`, `web-ui`.' agents/stages/plan.md`
  prints `1` (compare with whitespace collapsed if the sentence wraps). As a
  negative check during implementation, with the `web-ui` directory added
  and `plan.md` unchanged, the spec 077 AC-4 stages test and the profiles
  list test fail; both pass after AC-4 and AC-5.
- AC-6: `git diff main --stat` lists the seven files of section 4 and no
  other; `pnpm -F @panelator/scheduler typecheck` is clean; the design-tree
  check in `pnpm test` accepts this spec's `Parent:` line and its entry under
  the parent's `## Children`.

## 6. Open decisions

None.
