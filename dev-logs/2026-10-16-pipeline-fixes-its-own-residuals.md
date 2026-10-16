# 2026-10-16: the pipeline fixes its own review residuals (specs 003 to 005)

Same day as the first live run. The three residuals left by the spec 001
branch review (R2 orphaned-scope ceiling, R3 pi tool names, R4 discarded
commits) were written up as specs 003, 004 and 005, each naming the exact
files it may touch, and run through the scheduler as issues #3, #4 and #5.
All three touch `tools/scheduler/`, so every chain went through the
automation gate (maintainer-set `validated`) and a security-profile review.

## Result

| Issue | Plan | Implement | Review | Outcome |
|---|---|---|---|---|
| #3 (R2) | ok | ok, PR #6 | approve | merged by the pipeline |
| #4 (R3) | ok | ok, PR #7 | invalid shape, then changes_requested, 1 finding | escalated; maintainer fixed and merged |
| #5 (R4) | invalid twice (findings as strings) | | | parked; prompts fixed, re-run |
| #5 re-run | ok, 2 findings queued | ok, PR #8 | escalate, 1 finding | escalated; maintainer fixed and merged |

The self-restart worked: after #3 merged, the next tick fast-forwarded the
checkout, logged `restart` for `tools/scheduler` and exited; the following
run claimed #4 on the new code.

Both escalations were correct and both findings were real. #7: the tool
name map resolved `toString` and `constructor` through `Object.prototype`
(fixed with an own-key check). #8: an uncommitted-work patch and a commits
patch saved in the same second overwrote each other, a collision spec 005
made likely and the plan itself had flagged but could not fix because
`patches.ts` was outside the spec's file list (fixed with a kind suffix and
exclusive create). On a sensitive path any finding blocks the merge until
the maintainer looks, so the chains ended in `needs-human` as designed and
the fixes were pushed to the PR branches and merged by hand.

## Defects in the pipeline itself, fixed directly (commit 9aba85c)

- The stage prompts showed `"findings": []` without the record shape, so a
  careful plan wrote its findings as strings and failed schema validation
  twice (the plan was otherwise fine). All four prompts now spell out the
  finding record of process-spec 4.2 and that no extra property is allowed.
- The review prompt never said `declined_to_judge` holds strings or that
  the result has exactly four fields; one review added `notes` and lost a
  round.
- The review input's CI summary was never filled: the driver passed
  nothing, so every review tried to run the suite with no shell. The driver
  now lists each check run's conclusion for the PR head and the prompt
  says not to run the suite when the checks passed.

## Numbers

Seventeen stage runs, 14.70 USD. Per successful chain the review is the
largest cost (0.89 to 1.74 USD, 10 to 18 turns); plans cost 0.68 to 1.44
USD; implements 0.21 to 0.30 USD on Sonnet. The two shape-rejected plans
on #5 cost 2.86 USD for nothing, the strongest argument for the prompt
fixes above.

## Open

- Resuming after a security escalation starts a fresh chain: the claim is
  released and the PR is not remembered, so re-validating an issue whose
  branch already has a PR would re-plan and re-implement onto a branch
  that cannot be fast-forwarded. Resolving the finding by hand and merging
  was the practical path today. A chain should resume at verify when a PR
  for `issue-N` already exists.
- Six findings sit in `findings/queue.jsonl` (the review-stage `pnpm test`
  instruction conflict, the patch-name collision now fixed, and the
  format-patch-omits-merges edge case). Nothing drains the queue yet.
