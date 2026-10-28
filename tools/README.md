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

## Event store, metrics and reflection (spec 012)

Everything the scheduler does is also recorded raw, as one JSON line, in
`events/<YYYY-MM>.jsonl` under the state directory (month of the event's `at`). The
envelope is `{ id, at, kind, issue?, run_id?, agent?, payload }`; the kinds and their
payloads are in `schemas/scheduler/event.json`. `recordEvent` is the only writer and
only appends; nothing rewrites or deletes under `events/`. `events/index.sqlite` is a
derived `node:sqlite` index (table `events`), loaded incrementally and rebuilt from the
JSONL whenever it is missing, unreadable or of an older schema version. The first start
after this code lands copies the older records (`usage/`, `merges.jsonl`, the action,
question, finding and parameter logs) in as events with `payload.backfilled: true`;
`events/backfilled.json` marks it done. Reserved: `aws.cost` has no producer yet, and
the `funds`, `credential` and `first_contact` maintainer-contact kinds belong to spec F2.

Commands (read the state directory, never write the JSONL, except `backfill`):

- `metrics [--weeks <n>] [--json] [--snapshot] [--all]`: the weekly report (default 12
  weeks, buckets are Mondays); `--snapshot` also records it as a `metrics.snapshot`
  event; `--all` includes retired metrics. `metrics show <name>`: one definition and its
  history.
- `events backfill`: run the backfill by hand (idempotent). `events query "<sql>"`: one
  read-only `SELECT` against the index.

A metric is `agents/metrics/<name>.yaml`: `name` (the file name), `goal` (speed,
delivery, quality, spend, autonomy), `description`, `unit`, `direction`, `introduced`,
`rationale` (at least 200 characters: what decision the metric drives and why it tracks
the goal), `query` (one `SELECT` over `events` returning `bucket, value, n`, using
`:from` and `:to`), optionally `replaces` and `retired`. A bad file stops the service
with exit 78 and fails the registry test. Changing a metric is a reviewed PR like any
`agents/` change. A definition with `replaces: <old>` requires `<old>` to stay for 28
days after its `introduced` date; until then the report shows both, the old one marked
`replaced_by`, and its new rationale must differ from the old one's.

Three standing agents reflect: `delivery-reflection` (weekly, or after ten merges),
`charter-reflection` (weekly; also reviews every maintainer contact and files issues to
automate recurring ones) and `meta-reflection` (every 30 days; judges the metrics and
the reflections). The scheduler builds their input (`reflection-input`), and applies
their result: the plan is saved under `reflections/<agent>/` and posted as a **plan
issue** (labels `reflection` and `reflection:<delivery|charter|meta>`, never
`validated`, so the shortlist ignores it), and each plan item becomes a `validated`
issue authored by the App, opening with `Plan: #<plan issue>`. At most
`reflection_max_issues` (default 8, `agents/scheduler.yaml`) items are filed per plan;
the rest are written into the plan as deferred, as are items with an unknown class, a
body under 200 characters or a `metric_change` without a `## Rationale` section. One plan
issue per agent is open at a time: filing a new one closes the previous. The markers in
the issues (`<!-- panelator-reflection:<key>:plan|<index> -->`) carry a key that is
stable for a reflection period, so a retry after a crash does not duplicate anything.
The scheduler creates the four `reflection` labels if they are missing.

Wiping the state directory forgets every claim but leaves their `in-progress` labels on GitHub; remove those by hand, or the issues are never picked up again.

v0 ships only the `backend` and `security` profiles. A plan whose domain names any other profile fails, and the firmware HIL check of spec section 8 has no owner until the firmware profile spec.
