Workspace packages for automation and CI scripts. One directory per tool.

- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.
