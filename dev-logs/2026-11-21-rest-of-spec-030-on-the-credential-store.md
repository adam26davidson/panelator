# 2026-11-21: the rest of spec 030 on spec 069's credential store (spec 099, issue #257)

Built: the `credentials` profile field (replaces `credential_hook`; new `schemas/scheduler/profile.json`;
`web-ui` profile updated too), the per-run shim directory and `bin/cred-exec.ts`, the hourly
`credential_expiry` producer, the request's Telegram rendering with fixed buttons and the scheduler acting
on the answer before the stage resumes, the `TelegramNotifier` (one chain, `channel` in the service log) and
alert replies, `checkContact` and the parties list, `contacts list|remove`, `checkInstallationScope`
(start-up, `--check-auth` and the credential check's pre-run), the `credential-check` standing agent and
`renew_credential`. `bin/gh` is untouched (ADR 0014).

Decisions made while building:
- `cred-exec.ts` is told its catalogue by `--catalogue` (default `agents/credentials.yaml`) so a test can use
  a fixture; the shim exports `PANELATOR_SHIM_DIR` so `cred-exec` strips only its own shim directory from
  `PATH` before looking for the real command.
- A command `check` still returns `skipped` from spec 069's `runCheck`, so `renew_credential` treats `skipped`
  after a successful renew command as success and still reads the expiry probe; only `failed` fails the row.
- The Telegram answer handler no longer writes the `answered` log line for a question with a request; the
  resume writes it after the scheduler has acted (the stage gets the transformed text, the line carries
  `request` and `outcome`).
- The `credential-check` agent is paused in `standingWorld` like `infra-health`, so it does not take the
  one slot the scripted worlds use.

On the laptop after deploy (not run here): `panelator-scheduler --check-auth` should print the scope as ok;
`panelator-scheduler contacts list` should print `[]`; then the first credential check run and the first
Telegram alert, with the service log lines carrying `channel`.
