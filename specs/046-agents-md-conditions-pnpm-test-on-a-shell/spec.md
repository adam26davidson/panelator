# 046. `AGENTS.md` tells only a session with a shell to run `pnpm test`

Status: written 2026-11-06 from the delivery-system design for issue #80;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops, so a stage must be able to follow
every instruction it is given) and section 10 ("Small work skips layers": a
bug spec hangs directly off a top design);
[017-read-only-stages-not-told-to-run-tests](../017-read-only-stages-not-told-to-run-tests/spec.md),
which conditioned the same instruction in the backend profile and the review
prompt, recorded `AGENTS.md` as out of its scope (its section 1 findings and
section 2), and whose sentence rule (AC-3) this spec applies to `AGENTS.md`;
the read-only tool rule of the claude adapter (invariant I5,
`tools/scheduler/src/adapters/claude.ts`: plan, review, the question check
and every conversation turn get `Read`, `Glob` and `Grep` whatever the
profile allows) and of the standing runner (`tools/scheduler/src/standing/run.ts`:
a standing agent's profile is narrowed to the same three tools).

## 1. Goal

`AGENTS.md` line 5 says, without condition, "Run `pnpm test` from the repo
root before claiming any task done, and include its output in your final
message." Claude Code loads the file into every session in the repository,
and the scheduler's `--setting-sources project` keeps it loaded for every
pipeline run (the claude adapter's own comment says so). Several of those
runs have no shell: the claude adapter gives the plan, review and
question-check stages and every conversation turn only `Read`, `Glob` and
`Grep` (I5), the pi adapter does the same (spec 004), and the standing
runner narrows a standing agent's profile to the same three tools. A run
that follows the sentence is denied, spends turns on the denial, and may
report the command it could not run as a missing verification; spec 017
section 1 records a review run that did exactly that under the backend
profile's copy of the sentence.

Spec 017 conditioned the profile's copy and the review prompt's sentence,
and left `AGENTS.md` as a finding because it was outside issue #25's scope.
This spec finishes the job: after it, no text a session without a shell
receives tells it to run the suite without saying what a session without a
shell does instead.

### What the spec agent found (2026-11-06)

- The sessions without a shell today are the plan, review and
  question-check stages (`claude.ts` line 38, `pi.ts` `READ_ONLY_STAGES`),
  every conversation turn (`run.conversation` in both adapters; spec 044
  made a conversation turn read-only), and the two standing agents
  (`findings-filer`, `action-audit`; `standing/run.ts` sets their tools to
  `Read`, `Glob`, `Grep` whatever the profile says). The sessions with a
  shell are the spec, design, implement and fix stages, and the
  maintainer's own interactive sessions, which also load the file.
- The implement and fix prompts already tell their stages to run
  `pnpm test` (`agents/stages/implement.md`, `agents/stages/fix.md`), and the
  backend profile's conditional sentence (spec 017 AC-1) covers the stages
  that render it. `AGENTS.md` is the only remaining unconditional copy
  (`grep -rn "pnpm test" AGENTS.md agents/`).
- `AGENTS.md` is on the sensitive-path list as test wiring (security
  criterion 10: a change must not drop, skip or narrow what `pnpm test`
  runs). Conditioning the sentence on having a shell changes nothing the
  suite runs and keeps the instruction for every session that can follow
  it, so the change does not weaken it; the implementation PR still gets
  the security review, as every sensitive diff does.
- No test reads `AGENTS.md` today; spec 017's guard tests (AC-3, AC-4)
  cover the profiles and the rendered stage prompts only. The same
  sentence rule is cheap to apply to the file, so a later edit cannot
  reintroduce the contradiction.
  *(agent's call: keep the sentence in `AGENTS.md`, conditioned, rather
  than remove it and rely on the profile and stage prompts. The file is
  also read by the maintainer's interactive sessions and by any harness
  that loads `AGENTS.md` without the scheduler's prompts, and spec 017
  chose the same shape for the profile. The stages are named in the text
  so a session can tell which case it is in without knowing the adapter;
  the list is checked by AC-3 so it cannot drift from the adapters.)*

## 2. Out of scope

- Any change to which tools a stage, a conversation turn or a standing agent
  may use: the claude adapter's read-only rule, the pi adapter's read-only
  list, the standing runner's narrowing and the `tools` lists in
  `profile.yaml` are unchanged.
- The backend profile's instructions, the review prompt, and spec 017's
  guard tests: unchanged. Spec 017 is not amended; its text recorded
  `AGENTS.md` as a finding and this spec is that finding's resolution.
- The implement and fix prompts, which keep their own `pnpm test`
  instruction.
- The rest of `AGENTS.md`: the first paragraph (the monorepo layout), the
  branch and push sentences of the second paragraph, and the third
  paragraph (who decides what; why the file is on the sensitive-path list)
  are unchanged.
- The sensitive-path list, the security review criteria and instructions,
  and what routes a sensitive diff to the security review.
- Whether `pnpm test` should run `pnpm install --frozen-lockfile` first or
  how (spec 035).

## 3. Acceptance criteria

AC-1. Given `AGENTS.md`, when it is read, then its instruction to run the
suite is conditioned on the session having a shell, and it tells a session
without one what to do instead. The text reads, in place of the first
sentence of the current second paragraph (line 5, "Run `pnpm test` from the
repo root before claiming any task done, and include its output in your
final message."):

> When your session has a shell (the spec, design, implement and fix
> stages, and an interactive session), run `pnpm test` from the repo root
> before claiming any task done, and include its output in your final
> message. A session without a shell (the plan, review and question-check
> stages, a conversation turn and a standing agent have only Read, Glob and
> Grep) judges by reading: do not try to run the suite, say in your result
> that you could not run it, and a command you could not run is not a
> missing verification.

The rest of the paragraph ("Commit on the branch you were told to use. A
pipeline stage pushes that branch ...") and the other two paragraphs are
unchanged, and the file still names `pnpm test` as the command to run from
the repo root.

AC-2. Given `AGENTS.md` read from the repository root (`repoRoot` in
`tools/scheduler/src/config.ts`), when its text is split into sentences the
way spec 017 AC-3 splits a profile (whitespace collapsed to one space, then
split on `. ` and on a full stop at the end of the text) and each sentence
that contains the instruction `` run `pnpm test` `` (matched without regard
to case, so the imperative at the start of a sentence counts) is examined,
then that sentence also contains the word `shell`, and at least one
sentence contains the instruction. The third paragraph's note that the
security review "checks that `pnpm test` is not weakened" is not an
instruction to run it and is not examined. This is a guard test: an edit
that reintroduces an unconditional instruction fails it, and an edit that
drops the instruction altogether fails it too.

AC-3. Given the same file, when the sentence that names the sessions
without a shell is examined, then it names `plan`, `review` and
`question-check` (the stages the claude adapter's I5 rule and the pi
adapter's `READ_ONLY_STAGES` make read-only), and a `conversation turn` and
a `standing agent` (the other two read-only runs). The test asserts each of
those five phrases appears in the sentence containing `without a shell`,
so the file's list cannot silently fall behind the adapters.

AC-4. Given the claude adapter, when a command is built for the plan,
review or question-check stage, then `--allowedTools` is still
`Read,Glob,Grep` plus the result-file write rule, exactly as the existing I5
test asserts; and `pnpm test` still runs every test it runs today (no
`vitest.config.*`, `package.json` or `pnpm-workspace.yaml` changes). This
spec changes one paragraph of prose and adds a guard test.

## 4. Interfaces and files

- `AGENTS.md`: the first sentence of the second paragraph is replaced by
  the two sentences of AC-1. No other line changes.
- `tools/scheduler/test/profiles.test.ts`: a test for AC-2 and AC-3 beside
  the spec 017 AC-3 test ("no profile tells a stage to run the suite without
  the shell condition"), reading `join(repoRoot, "AGENTS.md")` with
  `repoRoot` from `../src/config.ts` (already exported; `agentsDir` is
  built from it) and applying the same sentence split.
- `tools/scheduler/test/adapters-claude.test.ts`: unchanged; its existing
  I5 test is AC-4's verification.
- `docs/delivery-system-design.md`: this spec under `## Children`.

No other file is created or modified. `AGENTS.md` (test wiring) and
`tools/scheduler/` (the automation itself) are sensitive paths, so the
implementation PR gets the security review (spec 006 AC-9); security
criterion 10 is the one that applies, and the change keeps the `pnpm test`
instruction for every session that can run it and changes nothing the
suite runs. This spec plans no change to the charter, to a protected
maintainer decision, to the sensitive-path list, to the security review
criteria or instructions, or to what decides that a sensitive diff gets the
security review, that both reviews must approve, or that a sensitive path
must be listed in the spec. No tool allowlist, gate, bound, label rule,
stage prompt or profile changes.

## 5. Verification

- AC-1: read `AGENTS.md` on the PR branch; the quoted sentences are present
  verbatim, `git diff main -- AGENTS.md` touches only line 5, and
  `grep -c "pnpm test" AGENTS.md` prints `2` (the conditioned sentence and
  the third paragraph's note on the sensitive-path list).
- AC-2, AC-3: `pnpm test` from the repository root passes, including the
  new test. As a negative check during implementation, the AC-2 test fails
  against the current `AGENTS.md` (line 5 starts "Run `pnpm test`" and
  does not contain `shell`) before the wording change and passes after it.
- AC-4: the existing test "gives plan and review read-only tools whatever
  the profile allows (I5)" in `tools/scheduler/test/adapters-claude.test.ts`
  passes unchanged, and `git diff main --stat` shows no change under
  `package.json`, `pnpm-workspace.yaml` or any `vitest.config.*`.
- `pnpm -F @panelator/scheduler typecheck` is clean, and the design-tree
  check in `pnpm test` accepts this spec's `Parent:` line and its entry
  under the parent's `## Children`.

## 6. Open decisions

None.
