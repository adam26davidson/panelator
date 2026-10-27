Workspace packages for automation and CI scripts. One directory per tool.

- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.

## Operating the scheduler

Run the service from a dedicated clone of the repository, checked out on `main` with an https `origin`, not from a development checkout. The scheduler fast-forwards that checkout before every poll and restarts itself when `tools/scheduler/` or `agents/` changes, and stages push through a credential helper that only works over https. The unit's `WorkingDirectory` points at `~/Projects/panelator`; adjust it if the clone lives elsewhere. Node 26 must be first on the unit's `PATH`, since the scheduler runs its TypeScript directly.

The scheduler acts as a GitHub App installed on the repository with the permissions of spec section 12: issues, pull requests and contents (write), checks and actions (read), metadata (read), plus repository security advisories (write) once spec 004 lands. Set `app.id`, `app.installation_id`, `app.private_key_path` and `app.bot_login` in `agents/scheduler.yaml`; `repo`, `maintainer`, `slots`, `poll_interval_s`, `required_checks` and `state_dir` live in the same file. A missing App id, an unreadable private key, a checkout that is not on `main` or an origin that is not https makes the scheduler log a `config-error` record and exit 78, which the unit does not restart.

These labels must exist in the repository: `validated`, `in-progress`, `needs-decision`, `abandoned`, `needs-design-stage`, `blocked`, `priority`, `class:product`, `class:bug`, `class:tooling`, `class:dependency`. The old `needs-spec`, `needs-design`, `needs-clarification`, `needs-human` and `security-review` labels are no longer applied (spec 006). Enable branch protection on `main` requiring the `test` check, so a PR the scheduler merges has passed CI.

The first run is `node tools/scheduler/bin/scheduler.ts --check-auth`, which prints the bot login and token expiry, then `--once`, which runs one tick and waits for the chains it started. Only then enable the service.

Security findings go to the fix loop and nothing waits for a human to clear a label; see spec 006 (`specs/006-no-human-stops/spec.md`) for the escalation path, the question flow and the labels.

Wiping the state directory forgets every claim but leaves their `in-progress` labels on GitHub; remove those by hand, or the issues are never picked up again.

v0 ships only the `backend` and `security` profiles. A plan whose domain names any other profile fails, and the firmware HIL check of spec section 8 has no owner until the firmware profile spec.
