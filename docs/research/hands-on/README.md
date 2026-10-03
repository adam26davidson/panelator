# Hands-on harness comparison

Implements the hands-on phase specified at the end of
[../03-harness-evaluation.md](../03-harness-evaluation.md). Same task, verbatim,
through each surviving harness (pi, OpenCode, Goose, Hermes) on one Anthropic
and one OpenAI model, plus Codex (OpenAI only) and Claude Code (Anthropic only)
as controls. Unattended, fresh worktree per attempt, 30-minute timeout.

## Prerequisites

- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` exported (API keys, not
  subscription logins: the harnesses are third-party to both vendors, and the
  usage-dashboard cross-check in measurement 3 needs API accounts).
- Models set in `models.env`.
- Harnesses installed: `pi`, `opencode`, `goose`, `hermes`, `codex`, `claude`.

## Run

```
./run.sh pi anthropic        # one attempt
./resume.sh pi anthropic     # measurement 6: follow-up by session id
./run.sh pi anthropic badkey # with ANTHROPIC_API_KEY=invalid exported: measurement 4
```

Results land in `results/<id>/`: `command.txt`, `events.jsonl`, `stderr.log`,
`exit-code.txt`, `wall-seconds.txt`, `evaluation.txt` (independent checks:
tests pass on a clean run, commit exists, diff limited to `tools/gh-list/` and
lockfile), `extracted.json` (per-harness jq extraction; nulls mean the harness
did not emit the field), `procs-before/after.txt`. One row per attempt is
appended to `results.csv`.

Measurements 7 (model-swap friction), 9 (files outside the worktree, session
files) and 10 (interactive coexistence) are recorded by hand in
`notes.md` after the runs. Measurement 3's vendor-dashboard figures are copied
into `results.csv` by hand.

## Cleanup

```
git -C ../../.. worktree remove --force ../panelator-handson-<id>
git -C ../../.. branch -D hands-on/<id>
```
