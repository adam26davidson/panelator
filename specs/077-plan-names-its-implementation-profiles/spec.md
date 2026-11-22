# 077. The plan prompt names the domains that have an implementation profile

Status: written 2026-11-18 from the delivery-system design for issue #145;
specs derived from that design need no maintainer approval (design section 11).
Amends [001-scheduler-core](../001-scheduler-core/spec.md) section 9 (the
plan's domain is validated against the profile list, which now holds stage
profiles too), marked as section 4 records.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops: a stage must be told every rule the
gates hold it to, because nobody answers while it runs) and section 10 ("Small
work skips layers": a bug spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) section 9 (profiles: the
plan classifies the issue's domain, validated against the profile list;
implement, fix and review use that profile; `web-ui`, `widget`, `firmware` and
`infra` are filled by their own specs) and section 6 (the stage prompts in
`agents/stages/<name>.md`); [006-no-human-stops](../006-no-human-stops/spec.md)
AC-1 (a failed plan spends a retry, then a rescue, then the issue's bounds) and
D9 (the `spec` profile works the spec PR);
[029-design-stage](../029-design-stage/spec.md) AC-3 (the `design` profile
works the design PR; a `web-ui` or `widget` spec routes to the design stage);
[049-plan-prompt-names-the-directory-scope-entry](../049-plan-prompt-names-the-directory-scope-entry/spec.md)
(the precedent: a prompt states the rule its gate applies).

## 1. Goal

The plan stage's prompt (`agents/stages/plan.md`) tells the agent to classify
the issue's domain as one of `backend`, `web-ui`, `widget`, `firmware`,
`infra`. The chain driver then requires a profile directory of that name under
`agents/profiles/` and fails the plan otherwise
(`profile not available: <domain>`, the I4 check in
`tools/scheduler/src/chain/driver.ts`). Today only `backend` is an
implementation profile (`design`, `security` and `spec` are stage profiles),
so a plan for scheduler work that picks the natural-sounding `infra` spends an
attempt learning that only `backend` works; issue #41's first plan attempt
failed exactly so.

After this spec:

- the plan prompt says which domain belongs to which area of the repository,
  that work under `tools/`, `agents/` and the scheduler is `backend`, and which
  domains have an implementation profile today;
- the I4 check accepts only an implementation profile (the profile list less
  the stage profiles), so a plan cannot name `spec`, `design` or `security` as
  its domain and run implement under a stage's profile;
- the I4 failure reason names the implementation profiles, so a retry does not
  guess.

Failing a plan whose domain has no profile, rather than running it under
another profile, stays the intended behaviour (spec 006 plan, review focus 9;
`driver.test.ts` "fails a plan whose domain names a profile that does not
exist").

## 2. Out of scope

- Adding `web-ui`, `widget`, `firmware` or `infra` profiles. Each is its own
  spec's work (spec 001 section 9; the `web-ui-profile` planned child of the
  delivery-system design). That child's brief gains one clause here (section 4)
  so its spec also adds `web-ui` to the sentence of AC-1.
- The `Domain:` line of a spec's header. It is the spec's own vocabulary (spec
  001 section 10; spec 029 routes a `web-ui` or `widget` spec to the design
  stage by it), distinct from the plan result's `domain`, which names the
  profile implement, fix and review run under. Existing headers such as spec
  031's `Domain: automation` are not rewritten.
- `pickProfile`'s fallback to `backend` when no plan is held, and every other
  profile selection in `pickProfile` (the security review selection, the spec
  and design tracks). Unchanged.
- The escalation exemption: a plan result carrying `escalation` still skips
  the domain check (spec 006 AC-17, review focus 9).
- Mapping an unprofiled domain to `backend` in code. The driver keeps failing
  it; only the prompt and the reason change.

## 3. Acceptance criteria

- AC-1. **The plan prompt names the domains, their areas and the profiles that
  exist.** Given `agents/stages/plan.md` after this change, then the sentence
  `Classify the issue's domain as one of backend, web-ui, widget,
  firmware, infra.` is replaced by this text, word for word (line breaks may
  differ):

  > Set `domain` to the profile the implement, fix and review stages run
  > under, by where the work lies: `web-ui` for `web/`, `widget` for
  > `widgets/` and `sdk/`, `firmware` for `firmware/`, and `backend` for
  > everything else, including `backend/`, `tools/` (the scheduler among
  > them), `agents/`, `schemas/` and `docs/`. The domains with an
  > implementation profile today are: `backend`. A plan whose domain has no
  > implementation profile fails with `profile not available`; that is
  > intended, so do not put work that belongs to another domain under
  > `backend` to avoid it.

  Nothing else in the file changes. `infra` is no longer offered: no area of
  the repository maps to it, and its profile's spec will give it one.

- AC-2. Amended by [106-plan-waits-for-predecessor-issues](../106-plan-waits-for-predecessor-issues/spec.md) AC-3: a plan result of waiting names no domain and skips the check, as an escalating plan does. **The I4 check accepts only an implementation profile.** Given a plan
  result without `escalation` whose `domain` is not among the implementation
  profiles, when the chain driver handles the plan stage's result, then it
  returns `stage_failed` for `plan`, as today. The implementation profiles are
  the directories `listProfiles(agentsDir)` returns less the stage profiles
  `design`, `security` and `spec`; today that is `["backend"]`. So a domain of
  `firmware`, `infra`, `spec`, `design` or `security` fails the plan, and
  `backend` passes as today. Given a plan result carrying `escalation`, then
  the check is skipped, as today.

- AC-3. **The failure reason names the implementation profiles.** Given the
  failure of AC-2 with domain `<domain>`, then its reason is
  `profile not available: <domain> (implementation profiles: <names>)`, where
  `<names>` is the implementation profiles in `listProfiles` order joined by
  `, `. Today: `profile not available: infra (implementation profiles:
  backend)`. The reason reaches the plan's retry through the history as every
  stage failure reason does (spec 006 AC-1); nothing else carries it.

- AC-4. **A test keeps the prompt in step with the profile directory.** Given
  `pnpm test`, then:
  - a test in `tools/scheduler/test/stages.test.ts` reads `plan.md`, finds the
    sentence beginning `The domains with an implementation profile today are:`,
    takes the backticked names in it, and expects them to equal
    `implementationProfiles(agentsDir)`; it also expects `plan.md` not to
    contain `firmware, infra`, and to contain `` `tools/` `` and `` `agents/` ``
    in the same sentence as `` `backend` ``;
  - a test in `tools/scheduler/test/profiles.test.ts` expects
    `implementationProfiles(agentsDir)` to equal `["backend"]`, beside the
    existing assertion of the full list, which stays unchanged;
  - the existing driver test "fails a plan whose domain names a profile that
    does not exist" also expects the history's last entry to contain
    `profile not available: firmware (implementation profiles: backend)`;
  - a new driver test gives the plan the domain `spec` and expects the plan to
    fail with `profile not available: spec`.

  So a later spec that adds an implementation profile (the `web-ui-profile`
  child first) fails `pnpm test` until it adds the name to AC-1's sentence.

- AC-5. **Nothing else changes.** Given the implementation PR, then it edits
  only the files of section 4, the existing tests named in section 4 pass
  apart from the assertion AC-4 adds, and no stage definition frontmatter,
  gate, bound, label rule or profile directory changes.

## 4. Interfaces and files

- `tools/scheduler/src/profiles/resolve.ts`: add
  `export const STAGE_PROFILES: readonly string[] = ["design", "security", "spec"];`
  and `export function implementationProfiles(agentsDir: string): string[]`,
  returning `listProfiles(agentsDir)` with the names in `STAGE_PROFILES`
  removed, order kept.
- `tools/scheduler/src/chain/driver.ts`: in `stageEvent`'s `plan` case, the I4
  check uses `implementationProfiles(deps.agentsDir)` instead of
  `listProfiles(deps.agentsDir)` and returns the reason of AC-3. The import
  from `../profiles/resolve.ts` gains `implementationProfiles` (and drops
  `listProfiles` if nothing else in the file uses it). `pickProfile` is not
  changed.
- `agents/stages/plan.md`: the sentence of AC-1 is replaced; frontmatter and
  every other line unchanged.
- `tools/scheduler/test/stages.test.ts`: the test of AC-4, added inside the
  "committed stage prompts" describe block using its `read` helper.
- `tools/scheduler/test/profiles.test.ts`: the test of AC-4.
- `tools/scheduler/test/driver.test.ts`: the added assertion and the new test
  of AC-4, beside the existing I4 test, using its `setup` and `steps` helpers.

The spec PR itself adds this file, marks spec 001 section 9 with
`> Amended by [077-plan-names-its-implementation-profiles](../077-plan-names-its-implementation-profiles/spec.md) AC-2: the plan's domain is validated against the implementation profiles, the profile list less the stage profiles `design`, `security` and `spec`.`,
lists this spec under `## Children` in `docs/delivery-system-design.md`, and
adds to the `web-ui-profile` planned child's brief there that its spec adds
`` `web-ui` `` to the sentence of AC-1, which the test of AC-4 requires.

`agents/` and `tools/scheduler/` are sensitive paths
(`agents/sensitive-paths.txt`), so the security review applies to the
implementation PR (spec 006 AC-9). The paths the implementation touches under
them are `agents/stages/plan.md`, `tools/scheduler/src/profiles/resolve.ts`,
`tools/scheduler/src/chain/driver.ts`, `tools/scheduler/test/stages.test.ts`,
`tools/scheduler/test/profiles.test.ts` and
`tools/scheduler/test/driver.test.ts`, listed here so the scope gate accepts
the diff. The change rewords one sentence of a stage prompt, narrows the
plan's domain check (it refuses more domains, never fewer) and adds tests; it
does not touch `pickProfile` or the security-review selection, the sensitive
path list, the two-review rule, the listed-in-the-spec rule, any bound, label
rule, tool allowlist, permission or token handling, and it drops, skips or
narrows nothing `pnpm test` runs (security criteria 5 and 10). This spec plans
no change to the charter, to a protected maintainer decision, to the security
review criteria or instructions, or to what decides that a sensitive diff gets
the security review, that both reviews must approve, or that a sensitive path
must be listed in the spec.

## 5. Verification

- AC-1: `grep -c 'firmware, infra' agents/stages/plan.md` prints `0`;
  `grep -c 'The domains with an implementation profile today are: `backend`.' agents/stages/plan.md`
  prints `1` (the sentence may wrap: compare with whitespace collapsed);
  `git diff main -- agents/stages/plan.md` touches only the lines of the
  replaced sentence.
- AC-2, AC-3: the driver tests of AC-4 pass; reading `stageEvent` shows the
  check against `implementationProfiles` and the reason of AC-3, and
  `pickProfile` unchanged in `git diff main -- tools/scheduler/src/chain/driver.ts`.
- AC-4: `pnpm test` from the repository root passes, including the new tests.
  As a negative check during implementation, the stages test fails against the
  `plan.md` on `main` and passes after AC-1's change.
- AC-5: `git diff main --stat` lists the six files of section 4 and no other;
  `pnpm -F @panelator/scheduler typecheck` is clean; the design-tree check in
  `pnpm test` accepts this spec's `Parent:` line and its entry under the
  parent's `## Children`.
- Live check after deploy: the next plan for a scheduler issue names
  `backend` on its first attempt, and no plan fails with a bare
  `profile not available: <domain>` reason.

## 6. Open decisions

None.
