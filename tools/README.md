Workspace packages for automation and CI scripts. One directory per tool.

- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.

## Operating the scheduler

Run the service from a dedicated clone of the repository, checked out on `main` with an https `origin`, not from a development checkout. The scheduler fast-forwards that checkout before every poll and restarts itself when `tools/scheduler/` or `agents/` changes, and stages push through a credential helper that only works over https. The unit's `WorkingDirectory` points at `~/Projects/panelator`; adjust it if the clone lives elsewhere. Node 26 must be first on the unit's `PATH`, since the scheduler runs its TypeScript directly.

The scheduler acts as a GitHub App installed on the repository with the permissions of spec section 12: issues, pull requests and contents (write), checks and actions (read), metadata (read), plus repository security advisories (write) once the filing agent (design spec C) lands. Set `app.id`, `app.installation_id`, `app.private_key_path` and `app.bot_login` in `agents/scheduler.yaml`; `repo`, `maintainer`, `slots`, `poll_interval_s`, `required_checks` and `state_dir` live in the same file. A missing App id, an unreadable private key, a checkout that is not on `main` or an origin that is not https makes the scheduler log a `config-error` record and exit 78, which the unit does not restart.

These labels must exist in the repository: `validated`, `in-progress`, `needs-decision`, `abandoned`, `needs-design-stage`, `blocked`, `priority`, `class:product`, `class:bug`, `class:tooling`, `class:dependency`. The old `needs-spec`, `needs-design`, `needs-clarification`, `needs-human` and `security-review` labels are no longer applied (spec 006). Enable branch protection on `main` requiring the `test` check, so a PR the scheduler merges has passed CI.

The first run is `node tools/scheduler/bin/scheduler.ts --check-auth`, which prints the bot login and token expiry, then `--once`, which runs one tick and waits for the chains it started. Only then enable the service.

Security findings go to the fix loop and nothing waits for a human to clear a label; see spec 006 (`specs/006-no-human-stops/spec.md`) for the escalation path, the question flow and the labels.

## Standing agents, actions and parameters

`agents/standing/<name>.md` is a standing agent: YAML frontmatter declares a schedule
(minimum `1h`) and/or event subscriptions, harness/model, bounds, schemas, read-only or
fresh worktree, profile and allowed action kinds. The body is its prompt. Files are
validated at startup; adding/removing one through a reviewed PR reloads the registry
at the next drained self-update. The shipped agents are `findings-filer` (daily plus
queue/abandonment events) and `action-audit` (weekly). They share the configured slots
with issue chains, after answered questions and before new issue claims.

Local commands run as the service user, using the same config/state directory. They do
not require the service checkout to be on main or App authentication (except workflow
undo, which needs the App). Use `node tools/scheduler/bin/scheduler.ts` followed by:

- `agent list`, `agent pause <name>`, `agent resume <name>`, `agent run <name>`.
- `action list [--since <ISO time>]`, `action undo <id>`.
- `param list`, `param set <name> <value>`, `param mode <name> auto|locked`.

Numbers and booleans use JSON syntax; durations use `1h`, `12h`, `7d`, etc. Only the
maintainer commands may change a parameter's mode or resume a maintainer-paused agent.
`system_work_share` replaces the fixed feature/debt ratio; `slots` is read every tick.
`schedule.<agent>` parameters preserve their values and locks across registry changes.

`agents/actions.yaml` sets levels. Level 1 requests are checked and logged before their
effect; level 2 requests are refused and queued as findings for a reviewed PR. The log
is `actions/log.jsonl`, parameter history is `parameters/history.jsonl`, agent state is
`agents/<name>.json`, and filer decisions/cursor are `findings/triage.jsonl` and
`findings/cursor.json` under the state directory. A startup marks interrupted pending
actions failed rather than replaying external side effects. Workflow re-run and cancel
require **actions:write** on the App; with actions:read their 403 is logged as failed.
Security findings are routed to draft repository advisories, never public issues.

Wiping the state directory forgets every claim but leaves their `in-progress` labels on GitHub; remove those by hand, or the issues are never picked up again.

v0 ships only the `backend` and `security` profiles. A plan whose domain names any other profile fails, and the firmware HIL check of spec section 8 has no owner until the firmware profile spec.

## Events, metrics and reflection (spec 012)

**The event store.** The scheduler appends every run, stage transition, merge, CI result, review, finding, action,
question, pause, slot sample, notification, parameter change and standing-agent run as one JSON line to
`events/<YYYY-MM>.jsonl` in its state directory, through `recordEvent`, the only writer. Nothing rewrites or deletes
those files. `events/index.sqlite` is a derived `node:sqlite` index, rebuilt from the JSONL whenever it is missing,
unreadable or of an older version; the service backfills the older records (`usage/`, `merges.jsonl`, the action,
question, finding and parameter logs) once at its first start.

- `panelator-scheduler events backfill` runs the backfill by hand (a second run records nothing).
- `panelator-scheduler events query "<sql>"` runs one read-only `SELECT` against the index and prints JSON lines.
- `panelator-scheduler metrics [--weeks n] [--json] [--snapshot] [--all]` prints the report for the last `n` weeks
  (default 12), one row per metric and week; `--snapshot` also records it as a `metrics.snapshot` event, `--all`
  includes retired metrics. `metrics show <name>` prints one definition and its full history from the ISO week of the earliest recorded event (including backfilled events) to now.

**Metrics** are definition files in `agents/metrics/<name>.yaml`: `name` (the file name), `goal` (`speed`, `delivery`,
`quality`, `spend` or `autonomy`), `description`, `unit`, `direction` (`lower` or `higher` is better), `introduced`,
`rationale` (at least 200 characters: the decision the metric drives and why it tracks the goal), and `query`, one
read-only `SELECT` over the `events` table returning `(bucket, value, n)` with the parameters `:from` and `:to`
(buckets are the Monday of each week). `replaces` names a metric the new one supersedes, which must keep being
computed for 28 days after `introduced`, with a rationale of its own; `retired` is a date after which a metric is
left out of the report. A bad definition stops the service with exit 78 and fails `pnpm test`. A change under
`agents/metrics/` is a reviewed PR like any change under `agents/`; a reflection proposes one only as an issue.

**Reflection agents** (`agents/standing/`): `delivery-reflection` (weekly, or after ten merges) looks for bottlenecks,
metric trends and design-tree gaps; `charter-reflection` (weekly) judges the system against each charter clause and
reviews every maintainer contact; `meta-reflection` (monthly) judges the metrics and the reflections. Each returns a
plan; the scheduler writes it to `reflections/<agent>/` and creates a **plan issue** as the App, labelled
`reflection` and `reflection:<delivery|charter|meta>` and never `validated`, so the shortlist ignores it. The
plan's items become `validated` issues, at most `reflection_max_issues` (default 8) per plan, each opening with
`Plan: #<plan issue>`; the rest are listed in the plan as deferred. The previous plan issue of the same agent is
closed when the new one is filed.
