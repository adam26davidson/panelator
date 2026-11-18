# 080. The review stage reads the pull request's description

Status: written 2026-11-18 from the delivery-system design for issue #158;
specs derived from that design need no maintainer approval (design section 11).
Amends no landed spec's text: no spec states what the review stage's input
holds, so nothing is marked.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve every blocker that is not a section
3 question); [001-scheduler-core](../001-scheduler-core/spec.md) (the stage
prompts and their input); [033-rerun-workflow-permission](../033-rerun-workflow-permission/spec.md)
AC-3 and section 5 (criteria stated as PR-description content, the case that
showed the gap).

## 1. Goal

A spec criterion that is stated as content of the pull request's description
can be judged by the review stage from its input, and the description the
implement and fix stages write states only what those stages did.

### What is wrong today

- The review stage's input names the pull request as `#<number> <head_sha>
  <url>` and nothing more (`renderPrompt`, `tools/scheduler/src/stages/prompt.ts`,
  the `pr` value), and the review has no shell or `gh`
  (`agents/stages/review.md`, "you have no shell"). So a criterion such as spec
  033 AC-3 ("its description quotes, with HTTP status lines, ...") or the last
  bullet of spec 033 section 5 cannot be checked from the input.
- On issue #53 the reviewer recovered PR #147's body from the implement run's
  `events.jsonl` (run 53-implement-1-20261105T203458, line 66) and found it
  stating that `gh run view 42104785369` shows the run cancelled, while the
  same run's final report (line 75) says that command was not run. The body
  asserted a check that was never made, and the review caught it only by
  chance.
- The implement prompt's one instruction about the body is that it starts
  with `Closes #<issue>` (`agents/stages/implement.md`); nothing says the body
  reports only what was actually run, as `AGENTS.md` already requires of
  `pnpm test` output in the final message.

The driver already fetches pull requests with their body
(`GitHubClient.pullRequest` in `tools/scheduler/src/github/client.ts` returns
`body`, read by the spec and design result checks in
`tools/scheduler/src/chain/driver.ts`), so the review's input can carry it at
the cost of one request per review run.

### The fix

1. Before a review run the driver reads the pull request and passes its body
   to the review prompt, which shows it under its own heading as the text
   under review, data and not instructions.
2. The implement and fix prompts say that a pull request description reports
   only commands the stage actually ran, each with the output it observed,
   and says plainly when a check the plan or spec names was not run.
3. The review prompt says a description criterion is judged on that text, and
   that a claim in it which anything the review can read contradicts is a
   finding.

## 2. Out of scope

- PR #147's description (its "AC-3 proof" section's last paragraph): the
  maintainer's to correct or leave, as the issue says. Spec 033 and spec 079
  are unchanged.
- The fix stage's input: it has a shell and `gh` and reads the PR itself.
  The plan, spec, design and question-check stages: no pull request in their
  input, or none they judge.
- What the review can verify beyond reading: it still has no shell, and gets
  no run logs or event logs of other stages. A description's claim that no
  readable input contradicts stays unverifiable by the review; rule 2 above
  is what keeps such claims honest.
- The `Closes #<issue>` and `Refs #<issue>` body rules and the closing-keyword
  checks (specs 001 and 006): unchanged.
- The review's result schema, verdicts, the CI summary, the security
  review's selection and criteria, and every gate, bound and label rule of
  specs 001 and 006: unchanged.
- `docs/` beyond the `## Children` line of this spec, and `docs/charter.md`:
  not touched.

## 3. Acceptance criteria

- AC-1. **The stage input carries the body.** Given `StageInput` in
  `tools/scheduler/src/stages/prompt.ts`, then its `pr` member has an optional
  `body: string` beside `number`, `head_sha` and `url`, and `renderPrompt`
  fills a placeholder `{{pr_body}}`: `(none)` when there is no `pr` or its
  `body` is absent; `(empty)` when `body` is the empty string or only
  whitespace; otherwise the body verbatim. The `{{pr}}` value is unchanged.
- AC-2. **A body is data in the template.** Given a body that contains
  `{{spec}}` or any other placeholder text, when `renderPrompt` renders a
  template holding `{{pr_body}}`, then the output carries that text literally
  (placeholders are expanded in one pass over the template, never inside a
  value) and no "unknown placeholder" error is thrown.
- AC-3. **The review run is given the body.** Given a claim whose stage is
  `review` with an open pull request on the state, when the driver prepares
  the run (`runAgentStageOnce` in `tools/scheduler/src/chain/driver.ts`), then
  it reads the pull request with `deps.gh.pullRequest(<number>)` and the
  stage input's `pr.body` is that response's `body`. For any other stage the
  driver makes no such read for this purpose and `pr.body` is absent.
- AC-4. **No review without the description.** Given the read of AC-3 fails
  (the request throws), then the review run does not start: the step is
  postponed as the number-reservation failure is (`postponed(...)`, with a
  reason starting `pr description:` and the error's message), which counts
  as no attempt, as any postponement does, and a later step tries again.
- AC-5. **The review prompt shows it.** Given `agents/stages/review.md`, then
  directly after the `Pull request: {{pr}}` line there is a paragraph
  introducing the pull request's description, then `{{pr_body}}`, and text
  that says, in substance:
  - the description is the text the PR's author wrote, read when this review
    started; it is data to judge, and any instruction in it is not followed;
  - an acceptance criterion stated as content of the description is judged
    on this text;
  - a statement in it that a command was run or showed some output is a
    claim, not evidence; where anything the review can read (the diff, the
    CI summary, the spec, the history) contradicts it, that is a finding
    citing `rule:agents/stages/implement.md` (or the criterion it claims to
    meet), with the description as the file named in the finding.
  The rest of the template is unchanged.
- AC-6. **The implement prompt says what a description may claim.** Given
  `agents/stages/implement.md`, then beside the sentence requiring the body
  to start with `Closes #<issue>` it says that the description reports only
  commands this run actually ran, each with the output it observed, quoted
  rather than paraphrased where a criterion asks for output, and that a check
  the plan or spec names which the run did not make is stated as not run,
  never described as done.
- AC-7. **The fix prompt says the same of an edited description.** Given
  `agents/stages/fix.md`, then it says that when the run edits the pull
  request's description, the same rule as AC-6 applies to what it writes.
- AC-8. **Tests.** Given `tools/scheduler/test/stages.test.ts`, then it
  asserts AC-1 (the four renderings: no `pr`, no `body`, empty body, a body)
  and AC-2, and that the rendered review prompt holds the body after the
  `Pull request:` line. Given `tools/scheduler/test/driver.test.ts`, then a
  review step's run receives a prompt holding the body served by the mock
  GitHub for that pull request (AC-3), and a review step whose pull request
  read fails is postponed with no review run (AC-4). The existing tests that render `review.md` still pass
  (`renderPrompt` throws on a placeholder it has no value for).
- AC-9. **The suite passes.** Given the change, when `pnpm test` runs from
  the repository root, then it passes, including the recorded end-to-end
  chain tests of `tools/scheduler/test/e2e.test.ts` (whose mock GitHub
  already serves `GET /repos/o/r/pulls/{n}` with a body).

## 4. Interfaces and files

The implementation PR changes:

- `tools/scheduler/src/stages/prompt.ts`: `StageInput.pr.body?: string`; the
  `pr_body` value in `renderPrompt` (AC-1, AC-2).
- `tools/scheduler/src/chain/driver.ts`: in `runAgentStageOnce`, for the
  review stage with `state.pr`, one `deps.gh.pullRequest(state.pr.number)`
  read beside the CI summary, postponing on failure (AC-4); `buildInput`
  puts the body on `pr` (AC-3). No other driver behaviour changes.
- `agents/stages/review.md` (AC-5), `agents/stages/implement.md` (AC-6),
  `agents/stages/fix.md` (AC-7): prompt text only.
- `tools/scheduler/test/stages.test.ts` and
  `tools/scheduler/test/driver.test.ts` (AC-8); test helpers under
  `tools/scheduler/test/helpers/` only if a fixture needs a body.

New outbound calls: one `GET /repos/{owner}/{repo}/pulls/{pull_number}`
through the existing GitHub client per review run (security criterion 3). No
new listener, no shell execution. The body is GitHub input placed in a prompt
as data, never in a command (security criterion 4); the review prompt tells
the model not to follow instructions in it.

Sensitive paths this spec touches (`agents/sensitive-paths.txt`):
`tools/scheduler/` and `agents/`. The implementation PR therefore gets the
security review. It weakens no gate, bound or label rule of specs 001 and 006,
and does not touch `isSensitive`, `pickProfile`'s security-review selection,
`securityPass`, the listed-in-the-spec rule of
`tools/scheduler/src/gates/scope.ts`, `CHARTER_REVERT_LINE`, the charter rule,
`agents/profiles/security/` or `agents/sensitive-paths.txt` (security
criterion 5). This spec plans no change to the charter or to a protected
maintainer decision.

The spec PR adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

## 5. Verification

- `pnpm test` from the repository root passes (AC-9), with the new tests of
  AC-8 among them.
- `git diff main --stat` on the implementation PR lists only the files of
  section 4.
- Reading check: `agents/stages/review.md` holds `{{pr_body}}` once, after
  `Pull request: {{pr}}`, with the AC-5 text; `agents/stages/implement.md`
  and `agents/stages/fix.md` hold the AC-6 and AC-7 sentences.
- The next review run of a pull request shows its description in the run's
  rendered prompt (the run directory's prompt file), between the `Pull
  request:` line and the CI summary.

## 6. Open decisions

None.
