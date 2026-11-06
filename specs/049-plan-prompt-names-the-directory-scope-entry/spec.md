# 049. The plan, implement and fix prompts say a `files` entry ending in `/` covers a directory

Status: written 2026-11-06 from the delivery-system design for issue #84;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops: a stage must be told every rule the
gates hold it to, because nobody answers while it runs) and section 10 ("Small
work skips layers": a bug spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) section 6 (the stage
prompts in `agents/stages/<name>.md`) and AC-10 and the section 8 Scope row
(the diff must lie within the plan's file scope, lockfiles and `schemas/`
excepted; both superseded by spec 006, which keeps the rule);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-1 (a second scope
violation is a bound: the chain spends a rescue, a re-plan, a spec revision
and then abandons the issue on a gap the plan could not have closed). This
spec marks no earlier text: spec 006 describes the scope gate without listing
the forms a `files` entry may take, and specs 026, 027 and 028 describe the
directory form only for their own plans. AC-1 below is the spec statement of
the form, and matches the gate as it is.

## 1. Goal

Every stage that writes or is held to a plan's file scope is told the rule the
scope gate applies: a `files` entry that ends in `/` covers every file under
that directory. The plan stage is also told when to use it, so an
implementation that adds a helper, a fixture or a wrapper under a planned
directory passes the gate instead of failing it twice and spending the
issue's bounds.

### What is wrong today

`inScope` in `tools/scheduler/src/gates/scope.ts` (line 8 on `main`) treats a
plan `files` entry ending in `/` as a prefix and any other entry as an exact
path; the test "treats a plan directory entry as a prefix" in
`tools/scheduler/test/gates.test.ts` covers it. No text a stage receives says
so. `agents/stages/plan.md` line 42 asks each task for "the exact
repo-relative files it will create or modify", the result shape at line 48
shows `files: ["..."]` with no form, `agents/stages/implement.md` line 26
shows the plan as "your file scope; do not touch files outside it except
lockfiles and schemas/", and `agents/stages/fix.md` line 29 shows it as
"Plan (file scope)". The word "exact" tells the plan stage to do the opposite
of what a test-adding task needs.

The plan stage therefore lists only the files it can foresee. Three
implementation PRs for issue #15 (#34, #64, #72) failed the gate with
"outside plan file scope" on `tools/scheduler/test/helpers/e2e-routes.ts`,
`tools/scheduler/test/fixtures/events/backfill-state/*`,
`tools/scheduler/src/notify/recorded.ts` and
`tools/scheduler/src/notify/log.ts`, none of which a plan could have named
before the code was written. The scheduler's escalation note for the
abandonment of #15 on 2026-10-31 lists the same files under "scope violated
a second time". Specs 026, 027 and 028 worked around the gap by instructing
their own plans to list directory entries in their section 5, which fixes
one spec at a time and nothing else.

### The fix

Say the rule where the plan is produced and where it is shown as the scope,
and guard the text with a test so an edit cannot drop it. The plan prompt
drops "exact", states the directory form, and says when to use it: a task
that adds tests, fixtures or helpers whose names are not known yet lists the
directory; a task that changes known files names them. The implement and fix
prompts state the form in the line that presents the plan as the scope, so a
stage reading a plan with a directory entry knows what it may touch. No ADR:
the change documents a rule the gate already enforces and has one clearly
right answer. *(agent's call: the gate is unchanged. Making the gate accept
unlisted files under a listed file's directory would widen every plan's scope
silently, and the issue places the gap in the prompt text, not the gate.)*

## 2. Out of scope

- `tools/scheduler/src/gates/scope.ts`: `inScope`, `scopeGate`, the
  `ALWAYS_ALLOWED` list and the violation message are unchanged. The gate
  already does what the prompts will describe.
- The spec-scope gate, the design-scope gate and the sensitive-path check
  (`isSensitive`, the listed-in-the-spec rule): unchanged. A directory entry
  in a plan does not make a sensitive file pass; the spec must still list it.
- `schemas/scheduler/plan-result.json` and the `PlanTask` type: the `files`
  items stay plain strings with no new constraint or description.
- The bounds of spec 006 AC-1 and the chain table rows for scope violations:
  unchanged.
- The rest of the three prompts: the escalation, follow-up, decide-mode and
  result-shape text, and every placeholder, are as on `main`. The result
  shape line of `plan.md` (line 48) is unchanged.
- Sections 5 of specs 026, 027 and 028, which describe the directory form for
  their own plans: left as they are. They remain correct and are not marked.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch, read as text,
and the vitest world of `tools/scheduler/test/stages.test.ts` where a
criterion names it. A sentence is a unit of the prompt text with whitespace
collapsed to one space, split on `. ` and on a full stop at the end of the
text, as the spec 017 AC-4 tests split a rendered prompt.

- AC-1. **The plan prompt states the directory form and when to use it.**
  Given `agents/stages/plan.md`, when an agent reads the paragraph that
  begins "Produce an ordered list of implementation tasks", then the
  paragraph no longer asks for "the exact repo-relative files", and it
  contains a sentence saying that a `files` entry that ends in `/` covers
  every file under that directory, followed by guidance that a task which
  adds tests, fixtures or helpers whose names are not yet known lists the
  directory (with an example such as `tools/scheduler/test/`), and a task
  that changes known files names each one. The text reads, in place of the
  first sentence of that paragraph (lines 42 to 43 on `main`, "Produce an
  ordered list of implementation tasks, each with the exact repo-relative
  files it will create or modify."):

  > Produce an ordered list of implementation tasks, each with the
  > repo-relative files it will create or modify. A `files` entry that ends
  > in `/` covers every file under that directory: list the directory when a
  > task adds tests, fixtures or helpers whose names are not yet known (for
  > example `tools/scheduler/test/`), and name a file exactly when the task
  > changes only files it already knows. The implementation may touch only
  > what the plan lists (lockfiles and `schemas/` excepted), so a helper
  > under an unlisted directory fails the scope gate.

  The rest of the paragraph ("Classify the issue's domain as one of ...",
  "If the spec cannot be implemented as written ...") is unchanged.
- AC-2. **The implement prompt states the form where it shows the scope.**
  Given `agents/stages/implement.md`, then the line that introduces the plan
  (line 26 on `main`, "Plan (your file scope; do not touch files outside it
  except lockfiles and schemas/):") also says that an entry ending in `/`
  covers every file under that directory; for example "Plan (your file
  scope; an entry ending in `/` covers every file under that directory; do
  not touch files outside it except lockfiles and schemas/):". The `{{plan}}`
  placeholder follows it on its own line as on `main`.
- AC-3. **The fix prompt states the form where it shows the scope.** Given
  `agents/stages/fix.md`, then the line that introduces the plan (line 29 on
  `main`, "Plan (file scope):") also says that an entry ending in `/` covers
  every file under that directory; for example "Plan (file scope; an entry
  ending in `/` covers every file under that directory):". The `{{plan}}`
  placeholder follows it on its own line as on `main`.
- AC-4. **A guard test keeps the rule in all three prompts.** Given
  `tools/scheduler/test/stages.test.ts`, when `pnpm test` runs, then a test
  in the "committed stage prompts" describe block reads `plan.md`,
  `implement.md` and `fix.md` from `agentsDir` and asserts, for each, that at
  least one sentence contains both the literal `` `/` `` and the word
  `directory`; and, for `plan.md` alone, that the sentence containing
  `` `/` `` also contains `fixtures` and that the file no longer contains
  "exact repo-relative files". The test fails against the prompts on `main`
  (none of the three contains `` `/` ``) and passes after AC-1 to AC-3.
- AC-5. **The prompts still render and keep every other guarded phrase.**
  Given the three edited prompts, when the existing tests of
  `tools/scheduler/test/stages.test.ts` run ("every committed prompt renders
  with a full StageInput", the spec 017 AC-4 sentence test for `plan.md`,
  the escalation, follow-up, decide-mode and held-work tests for plan,
  implement and fix, and "plan.md hands its questions to the spec stage"),
  then all pass unchanged: the new text adds no placeholder, no sentence
  containing `pnpm test`, and no phrase those tests forbid.
- AC-6. **Nothing else moves.** Given the implementation PR's diff, then the
  only files it changes are `agents/stages/plan.md`,
  `agents/stages/implement.md`, `agents/stages/fix.md` and
  `tools/scheduler/test/stages.test.ts`; `tools/scheduler/src/gates/scope.ts`,
  `tools/scheduler/test/gates.test.ts`, `schemas/scheduler/plan-result.json`,
  `agents/sensitive-paths.txt` and `agents/profiles/` are unchanged; no text
  marked `(maintainer answer, question #<id>)` changes anywhere; and no gate,
  bound, label rule, tool allowlist or permission of specs 001 and 006
  changes (security criterion 5). The frontmatter of the three prompts
  (model, tier, bounds, permission, profile, input, output) is as on `main`.
- AC-7. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root and `pnpm -F @panelator/scheduler typecheck`
  runs, then both pass.

## 4. Interfaces and files

No schema, type, gate or interface change. The implementation PR edits four
files:

- `agents/stages/plan.md`: lines 42 to 43 on `main` are replaced by the text
  of AC-1. Nothing else in the file changes.
- `agents/stages/implement.md`: line 26 on `main` is reworded as AC-2 says.
  Nothing else in the file changes.
- `agents/stages/fix.md`: line 29 on `main` is reworded as AC-3 says.
  Nothing else in the file changes.
- `tools/scheduler/test/stages.test.ts`: one test added to the "committed
  stage prompts" describe block, beside the spec 017 AC-4 loop, using the
  block's existing `read` helper and the same sentence split
  (`.replace(/\s+/g, " ").split(/\.(?: |$)/)`), as AC-4 says. For example:

  ```ts
  for (const n of ["plan", "implement", "fix"]) {
    it(`${n}.md says a files entry ending in / covers a directory (spec 049 AC-4)`, () => {
      const sentences = read(n).replace(/\s+/g, " ").split(/\.(?: |$)/);
      expect(sentences.some((s) => s.includes("`/`") && s.includes("directory"))).toBe(true);
    });
  }
  it("plan.md says when to list a directory and no longer asks for exact files (spec 049 AC-1)", () => {
    const t = read("plan").replace(/\s+/g, " ");
    expect(t.split(/\.(?: |$)/).find((s) => s.includes("`/`"))).toContain("fixtures");
    expect(t).not.toContain("exact repo-relative files");
  });
  ```

The spec PR itself adds
`specs/049-plan-prompt-names-the-directory-scope-entry/spec.md` and lists it
under `## Children` in `docs/delivery-system-design.md`.

`agents/` and `tools/scheduler/` are sensitive paths
(`agents/sensitive-paths.txt`); the security review applies to the
implementation PR (spec 006 AC-9). The paths the implementation touches
under them are `agents/stages/plan.md`, `agents/stages/implement.md`,
`agents/stages/fix.md` and `tools/scheduler/test/stages.test.ts`, listed here
so the scope gate accepts the diff. The change rewords three sentences of
stage prompts to describe a rule the scope gate already applies and adds a
guard test; it touches no gate, bound, label rule, tool allowlist, permission
or token handling, and it drops, skips or narrows nothing `pnpm test` runs
(security criterion 10). This spec plans no change to the charter, to a
protected maintainer decision, to the sensitive-path list, to the security
review criteria or instructions, or to what decides that a sensitive diff
gets the security review, that both reviews must approve, or that a
sensitive path must be listed in the spec.

## 5. Verification

- AC-1 to AC-3: read the three prompts on the PR branch; the sentences are
  present as the criteria say.
  `grep -n 'exact repo-relative' agents/stages/plan.md` prints nothing;
  `grep -c 'ends in `/`\|ending in `/`' agents/stages/plan.md agents/stages/implement.md agents/stages/fix.md`
  prints `1` for each file;
  `git diff main -- agents/stages/plan.md` touches only lines 42 to 43,
  `git diff main -- agents/stages/implement.md` only line 26, and
  `git diff main -- agents/stages/fix.md` only line 29.
- AC-4: `pnpm test` from the repository root passes, including the new
  tests. As a negative check during implementation, the AC-4 tests fail
  against the prompts on `main` before the wording change and pass after it.
- AC-5: the named existing tests in `tools/scheduler/test/stages.test.ts`
  pass unchanged;
  `git diff main -- tools/scheduler/test/stages.test.ts` shows only added
  lines inside the "committed stage prompts" describe block.
- AC-6: `git diff main --stat` lists the four files of section 4 and no
  other; `git diff main -- agents/stages/*.md | grep '^[-+]' | grep -v '^[-+][-+]' | grep -c ':'`
  shows no frontmatter line changed (the diffs touch only the body lines
  named above).
- AC-7: `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean; the design-tree check in
  `pnpm test` accepts this spec's `Parent:` line and its entry under the
  parent's `## Children`.
- Live check after deploy: the next plan for an issue whose spec adds tests
  lists a `tools/scheduler/test/` entry (or the equivalent directory for its
  domain), and its implementation PR's new helpers and fixtures under it
  pass the scope gate without a fix round for "outside plan file scope".

## 6. Open decisions

None.
