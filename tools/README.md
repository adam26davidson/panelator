Workspace packages for automation and CI scripts. One directory per tool.

- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.

## Operating the scheduler

Run the service from a dedicated clone of the repository, checked out on `main` with an https `origin`, not from a development checkout. The scheduler fast-forwards that checkout before every poll and restarts itself when `tools/scheduler/` or `agents/` changes, and stages push through a credential helper that only works over https. The unit's `WorkingDirectory` points at `~/Projects/panelator`; adjust it if the clone lives elsewhere. Node 26 must be first on the unit's `PATH`, since the scheduler runs its TypeScript directly.

The scheduler acts as a GitHub App installed on the repository with the permissions of spec section 12: issues, pull requests and contents (write), checks and actions (read), metadata (read), plus repository security advisories (write) once the filing agent (design spec C) lands. Set `app.id`, `app.installation_id`, `app.private_key_path` and `app.bot_login` in `agents/scheduler.yaml`; `repo`, `maintainer`, `slots`, `poll_interval_s`, `required_checks` and `state_dir` live in the same file. A missing App id, an unreadable private key, a checkout that is not on `main` or an origin that is not https makes the scheduler log a `config-error` record and exit 78, which the unit does not restart.

These labels must exist in the repository: `validated`, `in-progress`, `needs-decision`, `abandoned`, `blocked`, `priority`, `class:product`, `class:bug`, `class:tooling`, `class:dependency`. The old `needs-spec`, `needs-design`, `needs-clarification`, `needs-human` and `security-review` labels are no longer applied (spec 006), and neither is `needs-design-stage` (spec 029): the scheduler removes it once, with one comment, from an issue that still carries it. Enable branch protection on `main` requiring the `test` check, so a PR the scheduler merges has passed CI.

The first run is `node tools/scheduler/bin/scheduler.ts --check-auth`, which prints the bot login and token expiry, then `--once`, which runs one tick and waits for the chains it started. Only then enable the service.

Security findings go to the fix loop and nothing waits for a human to clear a label; see spec 006 (`specs/006-no-human-stops/spec.md`) for the escalation path, the question flow and the labels.

## The design stage and `tools/design-stage/` (spec 029)

A `web-ui` or `widget` spec on `main` without its design starts a chain at the **design stage** (`agents/stages/design.md`, strong tier, branch `design-<issue>`), which writes the spec's `design/` as Storybook stories, renders every named screen at mobile (390 by 844), tablet (820 by 1180) and desktop (1440 by 900) and opens a design PR. The PR is reviewed under the `design` profile (`agents/profiles/design/review-criteria.md`) by an independent reviewer who reads the PNGs, goes through the fix loop and merges; the chain then plans from the merged design. `bounds.design_revisions` in `agents/scheduler.yaml` (default 2) bounds design merges that still fail the UI-design gate before the spec agent revises the spec.

`tools/design-stage/` is the design tooling: `pnpm -F @panelator/design-stage storybook` serves every `specs/*/design/*.stories.tsx` with the base tokens of `src/tokens.css`; `pnpm -F @panelator/design-stage render <spec dir> [--screen <name>]` builds that spec's Storybook and writes `<screen>.png` (desktop), `<screen>.mobile.png`, `<screen>.tablet.png` and `<screen>--<state>.png` siblings beside the stories, each carrying a `panelator-render` PNG text chunk (viewport, story id, commit). The renderer needs Chromium, which `@playwright/browser-chromium` installs under `pnpm install`. Its toolchain versions are pinned once in the `catalog:` of `pnpm-workspace.yaml`, for `web/` and the console to reuse.

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
