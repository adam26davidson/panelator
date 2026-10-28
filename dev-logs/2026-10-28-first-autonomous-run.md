# 2026-10-28: the pipeline's first night without human stops

Spec 006 (no human stops) merged on 2026-10-27 21:00 UTC. The scheduler was
installed as a systemd user service running from a dedicated clone
(`~/Projects/panelator-pipeline`, drop-in `WorkingDirectory`), and five issues
were filed as the App bot with no `Spec:` line, so each started at the spec
stage: #9 (design spec A, Telegram), #10 (spec C, agent registry), and later
#12, #13, #15 (spec D), #17. This log records what happened in the first
~16 hours, observed by the maintainer's Claude Code session.

## What worked end to end

- **Spec stage to merge, no human.** Specs 007 to 012 were written by the spec
  stage, reviewed (normal plus security pass where sensitive), and merged.
- **Code to merge, no human.** #10 (spec 008: registry, direct actions,
  parameter store, findings filer, action audit), #12 (spec 010), #9 (spec
  007: Telegram) merged. The service restarted itself onto each scheduler
  change (`restart`, exit 75, `Restart=on-failure`) without incident.
- **Questions.** #9's implement raised a capability question (bot token and
  chat id). The question check sent it; the issue paused with
  `needs-decision`; the maintainer replied "done"; #9 resumed, ran the real
  `telegram-check` (`bot @panelator_bot`), and merged. After the restart the
  service logged `telegram connected`.
- **Escalation path.** A rebase conflict on #15's PR after #9 merged, with the
  fix loop used up, closed PR #30 (patch saved) and re-planned from main.
- **Quota.** The shared Claude subscription hit its session limit three
  times. Strong-tier stages postponed; standard-tier stages fell back to
  OpenAI (`openai/gpt-6.1-sol`) and finished.
- **Findings filer.** Its first run filed #25 and discarded others with
  reasons, after independent investigation.

## Defects found live (filed as pipeline issues)

| Issue | Defect |
|---|---|
| #12 | First `pnpm test` in a fresh worktree failed on an unapproved esbuild build (fixed, spec 010). |
| #13 | A stage that asks a question lost its unbound work (31 min of implement redone). Spec 011 merged; code PR #27 open. |
| #17 | A postponed chain did not hold its slot; with `slots: 1` four issues were claimed at once. Spec 009 merged; code PR #19 open. |
| #23 | Standing agents starve behind claimed issues when `slots` is 1. |
| #24 | A rate-limited standing agent retried every ~53 s for three hours (~200 runs) instead of postponing. |
| #25 | (filed by the filer) The backend profile tells read-only plan and review stages to run `pnpm test`. |
| #26 | The issue-list completeness check races with the filer's own issue creation. |
| #29 | Transient DNS failures (laptop resolver) counted as chain errors; #13 was released through the chain-error path. Priority. |
| #33 | The filer deadlocks: a failed security advisory appears twice in its batch, so no batch can validate. Priority. |

Also observed, not yet filed: an answered paused issue waits for every
claimed chain to finish, because claims are resumed before paused answers.

## Maintainer actions this run needed

- Telegram bot and `~/.config/panelator/telegram.json` (capability question, #9).
- GitHub App permissions: repository security advisories (write) for the
  filer's private advisories, and actions (write) for the `rerun_workflow`
  direct action. Both surfaced as failures, not yet as questions.

## Numbers

Roughly 16 hours: 6 specs and 3 code PRs merged, 1 maintainer reply, 0
abandoned issues, 3 quota exhaustions, one ~1 hour DNS outage.
