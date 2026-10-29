# 017. A stage without a shell is not told to run `pnpm test`

Status: written 2026-10-29 from the delivery-system design for issue #25;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops, so a stage must be able to follow
every instruction its prompt gives it) and section 10 ("Small work skips
layers": a bug spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) section 8 (the stage
prompt and its `{{profile_instructions}}` placeholder) and section 9 (a
profile's `instructions.md` is appended to the prompt of every stage that
runs under it); the read-only tool rule of the claude adapter (invariant
I5, `tools/scheduler/src/adapters/claude.ts`, tested in
`tools/scheduler/test/adapters-claude.test.ts`: plan, review and the
question check get `Read`, `Glob` and `Grep` whatever the profile allows).

## 1. Goal

The backend profile's instructions say, without condition, "Run `pnpm test`
from the repo root before writing your result." The same profile text is
rendered into every stage that runs under the profile, and the review stage
is one of them, but the review stage has no shell: the claude adapter gives
plan, review and the question check only `Read`, `Glob` and `Grep`, and
the pi adapter does the same (spec 004). A review run that follows the
profile is denied, spends turns on the denial, and may report the denied
command as a missing verification. Run `1-review-1-20261016T105403` did
exactly that: `pnpm test`, `pnpm run test` and `npx vitest run` were all
refused by permission.

The review prompt has since gained a sentence saying the stage has no
shell, but only "when every check succeeded". With a failed or pending
check the profile's instruction stands alone and cannot be followed.

After this spec, no text a stage without a shell receives tells it to run
the suite. The profile's instruction applies only to a stage that has a
shell, and says what a stage without one does instead; the review prompt's
no-shell sentence holds whatever the CI summary says. The tool lists do not
change.

### What the spec agent found (2026-10-29)

- The plan stage is defined with `profile: none` (`agents/stages/plan.md`
  frontmatter), and `pickProfile` in `tools/scheduler/src/chain/driver.ts`
  gives a stage with `profile: none` no profile, so its
  `{{profile_instructions}}` renders empty. The plan stage therefore does
  not receive the sentence today; the placeholder is in its template, so
  a later change to its profile would. The review stage is defined with
  `profile: from-issue`, and for a backend-domain issue (the default when
  the plan recorded no domain) it receives the backend instructions in
  full. The question check has `profile: none` too.
- On the spec track the review runs under the spec profile, and when the
  diff touches a sensitive path under the security profile; neither
  carries the sentence. Only the backend profile is affected today; the
  `web-ui`, `widget`, `firmware` and `infra` profiles do not exist yet.
- The implement and fix stage prompts already tell their stages to run
  `pnpm test` from the repo root (`agents/stages/implement.md`,
  `agents/stages/fix.md`), so the profile sentence adds nothing for the
  stages that can run it. It is kept, made conditional, rather than
  removed, so that a profile read on its own still states the rule for
  stages with a shell and the rule for stages without one.
  *(agent's call: a conditional sentence rather than moving it into the
  implement and fix prompts. The issue offers both; the conditional
  sentence keeps the profile self-contained and removes the contradiction
  for every stage that renders profile instructions, including a stage
  that is given a profile later, while moving the sentence would only
  duplicate what the two prompts already say.)*
- `AGENTS.md` carries the same unconditional instruction and is loaded
  into every Claude Code session. It is not a profile, is on the
  sensitive-path list as test wiring, and is outside the issue's scope;
  it is recorded as a finding, not changed here.

## 2. Out of scope

- Any change to which tools a stage or profile may use: the claude
  adapter's read-only rule for plan, review and the question check, the pi
  adapter's read-only list (spec 004), and the `tools` lists in
  `profile.yaml` are unchanged.
- Giving the review stage a shell, or having the scheduler run the suite
  on the review's behalf.
- What the review stage concludes from a failed or pending required check.
  The CI summary already reports each check's conclusion; how the reviewer
  weighs it is unchanged.
- `AGENTS.md`, the implement and fix stage prompts, the spec and security
  profiles, and the plan and question-check prompts (they render no
  profile text today; the guard test of AC-4 covers them in case that
  changes).
- The `web-ui`, `widget`, `firmware` and `infra` profiles, which do not
  exist yet; a profile written later is covered by the guard test of AC-3.

## 3. Acceptance criteria

AC-1. Given `agents/profiles/backend/instructions.md`, when it is read,
then its instruction to run the suite is conditioned on the stage having
a shell, and it tells a stage without one what to do instead. The text
reads, in place of the current second sentence:

> When your stage has a shell (implement and fix), run `pnpm test` from the
> repo root before writing your result. A stage without a shell (plan and
> review) judges by reading: do not try to run the suite, and a command you
> could not run is not a missing verification.

The first sentence (the profile's name and the directories it covers) and
the file-scope and findings sentences are unchanged.

AC-2. Given `agents/stages/review.md`, when it is read, then the sentence
introducing the CI summary says the stage has no shell without a
condition on the checks' outcome. The text reads, in place of the current
parenthesis:

> CI summary (each required check's conclusion for the pull request head;
> you have no shell, so do not try to run the suite yourself whatever the
> checks say: judge by reading, and take a failed or pending check as the
> summary reports it):

and the words "when every check succeeded" no longer appear in the file.

AC-3. Given every committed profile (`listProfiles(agentsDir)`), when its
resolved `instructions` text is split into sentences (on `. ` and on a
full stop at the end of the text) and each sentence that contains
`pnpm test` is examined, then that sentence also contains the word
`shell`, so no profile tells a stage to run the suite without the
condition. This is a guard test, so a profile added later (`web-ui`,
`widget`, `firmware`, `infra`) is held to the same rule.

AC-4. Given each read-only stage prompt (`plan.md`, `review.md`,
`question-check.md`) rendered with `renderPrompt` from a full
`StageInput` whose `profile_instructions` is the resolved backend
profile's `instructions`, when the rendered text is split into sentences
as in AC-3 and each sentence containing `pnpm test` is examined, then
that sentence also contains `shell`. Rendering with the backend text for
plan and question-check, which receive none today, keeps the guard in
force if either is given a profile later.

AC-5. Given the claude adapter, when a command is built for the plan,
review or question-check stage with the backend profile, then
`--allowedTools` is still `Read,Glob,Grep` plus the result-file write
rule, exactly as the existing I5 test asserts; this spec changes no tool
permission.

## 4. Interfaces and files

- `agents/profiles/backend/instructions.md`: the second sentence is
  replaced by the two sentences of AC-1. No other line changes.
- `agents/stages/review.md`: the CI-summary parenthesis (lines 30 to 31
  today) is replaced by the text of AC-2. The frontmatter and the rest of
  the body are unchanged.
- `tools/scheduler/test/profiles.test.ts`: a test for AC-3 over
  `listProfiles(agentsDir)` using the existing `resolveProfile`.
- `tools/scheduler/test/stages.test.ts`: a test for AC-4 in the
  "committed stage prompts" block, rendering the three read-only prompts
  with the `full` input of that block and `profile_instructions` set to
  the resolved backend instructions; and an assertion for AC-2 that
  `review.md` contains "you have no shell" and does not contain "when
  every check succeeded".
- `tools/scheduler/test/adapters-claude.test.ts`: unchanged; its existing
  I5 test is AC-5's verification.

No other file is created or modified. `agents/` and `tools/scheduler/` are
sensitive paths (the automation itself, as the sensitive-path list
records), so the implementation PR gets the security review. The change
rewords two sentences of prompt text and adds guard tests; it changes no
tool allowlist, no gate, no bound, no label rule and nothing that routes
a sensitive diff to the security review. This spec plans no change to the
charter, to a protected maintainer decision, to the sensitive-path list,
to the security review criteria or instructions, or to what decides that
a sensitive diff gets the security review, that both reviews must
approve, or that a sensitive path must be listed in the spec.

## 5. Verification

- AC-1, AC-2: read the two files on the PR branch; the quoted sentences
  are present verbatim and `grep -n "when every check succeeded"
  agents/stages/review.md` prints nothing.
- AC-3, AC-4: `pnpm test` from the repository root passes, including the
  new tests. As a negative check during implementation, the AC-3 test
  fails against the current `instructions.md` (its second sentence names
  `pnpm test` and not `shell`) before the wording change and passes after
  it.
- AC-5: the existing test "gives plan and review read-only tools whatever
  the profile allows (I5)" in `tools/scheduler/test/adapters-claude.test.ts`
  passes unchanged.
- `pnpm -F @panelator/scheduler typecheck` is clean, and the design-tree
  check in `pnpm test` accepts this spec's `Parent:` line and its entry
  under the parent's `## Children`.

## 6. Open decisions

None.
