# 2026-10-16: scheduler first live run (spec 001, AC-29)

One chain on a trivial spec (002, pipeline smoke run) against the real
repository, the real GitHub App and the real `claude` harness. Service run
by hand with `--once` from the main checkout, Node 26.9.0, Claude Code
2.1.292, `slots: 1`, systemd scopes and the sleep inhibitor enabled.

## Result

Issue #1 was claimed, planned, implemented, verified, reviewed and merged;
PR #2 was merged by `panelator-pipeline[bot]` at 10:56Z and the issue closed
with `in-progress` removed. Every stage left its run directory (command,
prompt, input, event stream, usage, outcome) and `merges.jsonl` holds the
merge. The claim, worktree and patches were cleaned up. Three `--once`
invocations were needed only because a single tick drives a chain until it
waits on CI; the service's poll loop does that itself.

## Defects found and fixed

1. A `Write(//path)` permission rule is accepted but never matched: Claude
   Code checks file-path rules for `Edit` and `Read` only, and an `Edit`
   rule also covers the Write tool. Under `dontAsk` the plan stage's result
   write was denied; the chain retried once and parked the issue as
   `needs-human`, which is the specified escalation. Fixed in the claude
   adapter (commit 186fc3a) and confirmed with a direct run: the one allowed
   path writes, any other path is still denied.
2. Before the run, CI on GitHub failed the rebase test because the runner
   has no git identity; the scheduler's own rebase now carries the bot
   identity (commit f1fac1e). The R1 residual from the branch review
   (stale worktree after `head_moved`) was fixed first (commit 6fb4c1c).

## Numbers

| Stage | Model | Turns | Cost USD | Wall | Peak memory |
|---|---|---|---|---|---|
| plan (denied write, attempt 1) | claude-fable-5-1 | 10 | 0.82 | 1m18s | 218M |
| plan (denied write, attempt 2) | claude-fable-5-1 | 7 | 0.65 | 48s | 211M |
| plan (after fix) | claude-fable-5-1 | 3 | 0.41 | 15s | 213M |
| implement | claude-sonnet-5-5 | 5 | 0.12 | 49s | 725M |
| review | claude-fable-5-1 | 26 | 1.14 | 2m33s | 218M |

Successful chain: 1.67 USD and about 3m40s of agent time for a three-line
Markdown file. The review stage is the expensive one; 26 turns to approve
a one-file PR suggests the review prompt should bound exploration for
small diffs. The two failed plan attempts cost 1.48 USD, so a harness
defect in an early stage costs roughly one chain per issue before it parks.

## Observations

- The review input's `CI summary` line was `(none)` although the `test`
  check had passed; the summary is only filled from failed checks. Worth
  passing the passed set too so the reviewer knows CI ran.
- The implement stage committed and pushed as the bot through the
  credential helper and opened the PR through the gh shim with no
  ambient credentials; the identity path works end to end.
- Session environment variables from a parent Claude Code session
  (`CLAUDECODE` and friends) were unset for the hand-run so the spawned
  harness did not see itself as nested. The systemd unit never has them.
