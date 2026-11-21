# 099. The rest of spec 030 on spec 069's credential store, with first contact on GitHub enforced by the installation's scope

Status: written 2026-11-20 from the delivery-system design for issue #257;
specs derived from that design need no maintainer approval (design section
11). Carries the criteria of [030-beyond-github](../030-beyond-github/spec.md)
that spec 069 left to "the issue that carries the rest of spec 030" (spec 069
section 1): AC-2's profile field, AC-3's shims and `cred exec`, AC-5, AC-6 to
AC-10, AC-11 and AC-12 (AC-11 as decided in [ADR 0014](../../docs/decisions/0014-github-first-contact-enforced-by-installation-scope.md)),
AC-13 and AC-14; AC-16 and AC-17 need nothing built (section 1). Supersedes
spec 030 AC-11's `gh`-argument gate and amends spec 030 section 1 (the gate
paragraph), AC-3 (`cred exec` is its own entry point), AC-8 (what a
`first_contact` approval does today) section 5 (the files), section 6 (the recorded first-contact run) and AC-13 (the
credential check's pre-run and input), and amends
[083-contact-records-leave-the-action-log](../083-contact-records-leave-the-action-log/spec.md)
AC-1 (the `gh` shim writes no `refused` line), each marked as section 4
records. *(agent's call)*
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Credentials", "First contact", "Telegram carries ... alerts"),
section 6.1 (the credential check on the roster; `credential_expiry`),
section 3 item 3, section 2 (anti-goal: no contact with a new outside party
without approval) and section 11 (row F2); [ADR 0014](../../docs/decisions/0014-github-first-contact-enforced-by-installation-scope.md)
(the installation's scope enforces first contact on GitHub);
[030-beyond-github](../030-beyond-github/spec.md) (every criterion built
here is spec 030's, as amended by specs 067, 068, 069, 072 and 083 and by
this spec); [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
AC-5 (`runCheck`, the one function every check goes through) and section 1
("How this reaches `main`", which asks for this issue);
[067-incomplete-request-is-sent-back-for-completion](../067-incomplete-request-is-sent-back-for-completion/spec.md)
AC-1 to AC-3 (the request's shape and completeness check, on `main`);
[083-contact-records-leave-the-action-log](../083-contact-records-leave-the-action-log/spec.md)
AC-2 to AC-5 (the contacts log, on `main`); [072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md)
AC-6 (the credential check's input has no plain-file list);
[001-scheduler-core](../001-scheduler-core/spec.md) section 12 (the `gh`
shim, the installation token); [008-agent-registry](../008-agent-registry/spec.md)
AC-4 (`credential_expiry`), AC-8, AC-9 and AC-12.

## 1. Goal

Finish row F2's first part on what `main` has. Spec 069 (issue #131, PR #247)
built spec 030 AC-1, AC-2, AC-3's App-key rule and AC-4 in
`tools/scheduler/src/credentials/`; spec 067 built the request's shape and
completeness check; spec 083 built the contacts log and the run's actor
variables; spec 064 took infra health (spec 030 AC-15, AC-17); spec 072
settled the plain files. What is left, and built here, is:

- the `credentials` profile field in place of `credential_hook`, the per-run
  shim directory and `cred exec` (spec 030 AC-2's last sentence and AC-3);
- the `credential_expiry` producer (AC-5);
- the request rendered with its fixed buttons and the scheduler acting on the
  answer, the "Done" path calling `runCheck` (AC-6 to AC-8);
- the `TelegramNotifier` and the reply to an alert (AC-9, AC-10);
- the first-contact gate as ADR 0014 decides it: `checkContact` and the
  parties list for later channels, the installation-scope check for GitHub,
  no `gh`-argument parser (AC-11), and the `contacts` commands (AC-12);
- the credential check agent and `renew_credential` (AC-13, AC-14), each
  calling spec 069's `runCheck` and adding no check of its own.

Spec 030 AC-16 (no AWS action) and AC-17 (superseded by spec 064 AC-6) need
nothing: the implementation adds `renew_credential` to `agents/actions.yaml`
and no `aws` kind, and files no restart finding of its own.

### Why AC-11 changes (ADR 0014, in short)

The `gh` shim and the git credential helper authenticate with the App's
installation token. The installation is `selected` on
`adam26davidson/panelator` alone, with repository permissions only, so
GitHub refuses a write to any other repository, REST or GraphQL, whatever the
arguments say. Spec 030's parser tried to decide the same thing from the
arguments and failed four reviews in a row (issue #39). The parser is
dropped; the scope is verified daily and at start-up; `checkContact` stays for
the channels that will need it.

## 2. Out of scope

- Everything spec 030 section 2 leaves out, and everything spec 068 (issue
  #130) carries: the `aws-sso` check and probe actually running, the
  `maintainer.contact` events for a request's send and answer, the `funds`
  layout, infra health's AWS half. The notifier reports which channel carried
  a notification (AC-9) so spec 068 AC-4's recorder has it; the event itself
  is spec 068's.
- Any parsing of `gh` arguments in the shim: no gate, no refusal, no log
  line (ADR 0014). The shim of spec 001 section 12 is unchanged.
- A contact that stays inside the configured repository, such as an
  `@mention` of another GitHub account in an issue or comment. Spec 030 AC-11
  never covered it and this spec does not; the result of this run files it as
  a finding for the filer to judge.
- A credential that can write to another repository (a token of the
  maintainer's, or a second installation): none exists, none is added. The
  first spec that adds one adds its wrapper's call to `checkContact` (spec
  030 section 2).
- Holding a notification until Telegram is back, collapsing repeats beyond
  spec 001's rate limiter, and choosing which gates reach the chat: issue
  #253's. AC-9 builds spec 030's sink (every gate, nothing retried); #253's
  spec builds on it.
- `cred import` with no `telegram` block (findings ref 861 on #39; still
  `cfg.telegram!` in `bin/scheduler.ts`): spec 069's command, filed as a
  finding by this run, not changed here.
- Spec 083's `redactCommand` (issue #342): it has no caller after ADR 0014
  and gains none here.

## 3. Acceptance criteria

"Given" states use spec 030 section 3's fakes (the fake harness, the mocked
GitHub API, the fake Telegram server, the fake `systemd-creds` of spec 069 at
`tools/scheduler/test/helpers/fake-systemd-creds`). *Test entry*: a catalogue
entry added by the test (the loader takes a path, so a test catalogue is a
fixture file) with `wrapper: { command: fakecmd, env: FAKE_SECRET }`, check
`fakecmd --check`, expiry `{ probe: "fakecmd --expiry" }` and `renew: { command:
"fakecmd --renew" }`, where `fakecmd` is a script under `test/helpers/` that
prints its environment variable's presence, an ISO time, or exits as the test
arranges. The repository catalogue's three entries are unchanged except where
AC-11 says.

**Wrappers** (spec 030 AC-2 last sentence, AC-3)

- AC-1. **`credentials` replaces `credential_hook`.** `agents/profiles/{backend,design,security,spec}/profile.yaml`
  lose `credential_hook: null` and gain `credentials: []`;
  `schemas/scheduler/profile.json` and `src/profiles/resolve.ts` know
  `credentials: [<name>, ...]` and reject `credential_hook`; a standing
  definition (`schemas/scheduler/standing-definition.json`, spec 008 AC-1)
  gains the same optional key. Given a name not in the catalogue, then
  loading fails as spec 008 AC-1 does, naming the profile or agent and the
  name. The four profile files are in the implementation's file scope (the
  plan lists them; findings ref 855 on #39 was a plan that did not).
- AC-2. **The shim directory, and only the wrapped child sees the secret.**
  Given a stage or standing run whose profile or definition lists
  credentials, then `writeShims(runDir, entries)` in
  `src/credentials/shims.ts` writes one executable shim per listed entry
  with a `wrapper` into `<run dir>/bin/`, and the run's `PATH` is `<run
  dir>/bin:<scheduler bin dir>:<inherited PATH>` (spec 001's `gh` shim and
  helper stay where they are). The shim runs
  `tools/scheduler/bin/cred-exec.ts <name> -- "$@"`, a separate entry point
  that loads the configuration, the catalogue entry and the store and nothing
  else (no registry, no state directories, no agent state: findings ref 860
  on #39), reads the secret with `readSecret`, sets the entry's `env` to it
  in the child's environment only, and execs the first `<command>` on the
  `PATH` after the shim directory, passing stdin, stdout, stderr and the
  exit status through. A `wrapper.command` must match `^[a-z][a-z0-9._-]*$`
  (no slash: findings ref 862): the catalogue loader and
  `schemas/scheduler/credential-catalogue.json` both say so, and a test
  asserts a command with a `/` fails loading. A run that lists no
  credentials gets no shim directory and the environment of spec 001
  unchanged. Tests assert: the wrapped child's environment carries the
  variable and the stage's own environment does not; the secret is in no log
  line, run record or file of the state directory after a wrapped call
  (spec 030 AC-1's "after a wrapped call" half); `cred-exec.ts` writes
  nothing under the state directory. The `aws-sso` entry's `check` and
  `expiry.probe` keep returning `skipped` from `runCheck` until spec 068
  routes them through `src/aws/cli.ts` (spec 030 AC-2's `provider: aws`
  rule); the shim directory is built for it like any other entry.

**The expiry producer** (spec 030 AC-5)

- AC-3. **`credential_expiry` has a producer.** Given a tick at least an hour
  after the last run of the step, then for each catalogue entry whose index
  `expires_at` is within `warn_days` or whose `last_check` is `failed: ...`,
  the scheduler emits `credential_expiry` with `{ name, expires_at,
  last_check }`, at most once per credential per day (the last emission per
  name kept in `credentials/expiry-state.json` under the state directory).
  An entry with expiry `none` and `last_check` `ok` or `null` never
  produces it. The step reads the index only; it runs no check.

**Requests** (spec 030 AC-6 to AC-8)

- AC-4. **The request is rendered with fixed buttons.** Given a sent
  question whose `request` is complete (spec 067 AC-1), then the issue
  comment keeps spec 067 AC-3's field list and the Telegram message renders
  the same fields (setup steps numbered, a `first_contact` message quoted in
  full), and the keyboard is `Done` and `Can't do this` for `credential`,
  `Approved` and `Declined` for `funds`, `Approve` and `Deny` for
  `first_contact`; the stage's own options stay in the comment and are not
  buttons. The question log entry (`schemas/scheduler/question-log-entry.json`)
  carries the request as `request`.
- AC-5. **The scheduler acts on the answer before the stage resumes.** Given
  an answer (button or text) to a question with a request, then before the
  asking session resumes (spec 007 AC-13):
  - `first_contact`: an approval (`Approve`, or a text whose first word is
    `approve`, `approved`, `yes` or `ok`, case-insensitive) appends `{ party,
    channel, approved_at, question_comment_id, issue }` to
    `contacts/parties.json` through `src/contacts/approve.ts`; the answer the
    stage receives is `approved (recorded; no channel can reach <party> yet:
    a credential that can is a credential request)` when `channel` is
    `github` or any channel with no wrapper (today, every channel), so the
    stage does not retry a write the installation token cannot make (ADR
    0014). Any other answer leaves the party unapproved.
  - `credential`: `Done` or a text starting `done` runs `runCheck` (spec 069
    AC-5) over the named entry when it is in the catalogue; `ok` gives the
    answer `done (verified)`, `failed` gives `done (check failed: <reason>)`,
    `skipped` gives `done (not checked: <reason>)`; a name not in the
    catalogue gives `done (unverified: <name> is not in the catalogue)`.
  - `funds`: passed through.

  The outcome (`approved`, `denied`, `verified`, `check_failed`, `declined`
  or `text`; the six of spec 068 AC-3, no seventh) is written as `outcome` on the entry's answer record (spec 007
  AC-9); `done (not checked: <reason>)` and `done (unverified: <name> is not in the
  catalogue)` are written as `text`: nothing was verified and nothing failed,
  so the maintainer's own words stand as the answer. The rest of the pause,
  resume and record path is unchanged.

**Alerts** (spec 030 AC-9, AC-10)

- AC-6. Amended by [102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md) AC-1, AC-2 and AC-3: a notification another path already delivers to the chat is not sent again, a notification the chat cannot take is held and delivered when it can, and the four-hour limiter is the collapser. **Every notification reaches the chat.** Given Telegram on, then the
  service's notifier is `rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`:
  the log line is written as today and the notification is sent to the chat
  as one message headed `<gate>: <label>` with `#<issue>` when the issue is
  non-zero, no buttons. `notify` resolves to `{ channel: "telegram" | "log" }`
  (spec 068 AC-4's hook), and the service log line gains `channel`. Given the
  send fails, then the log line stands, `telegram-send-failed` is logged once
  per outage (as spec 007 does for a question), and nothing is retried.
  Given Telegram off, then the notifier is today's chain and `channel` is
  `log`.
- AC-7. **A reply to an alert is not an answer.** Given a Telegram message
  that replies to a message the notifier sent (the poller keeps the sent
  message ids in `telegram/alerts.json`, at most the last 200), then it is
  matched to no question and the bot replies once: alerts take no reply, and
  the open questions, as `/questions` lists them.

**The first-contact gate** (spec 030 AC-11 and AC-12; ADR 0014)

- AC-8. **`checkContact` and the parties list exist for the channels that
  call them.** `checkContact(ctx, party)` in `src/contacts/gate.ts` returns
  `allowed` when `first_contact_needs_approval` is `false` (read from the
  parameter store at each call) or `party` is in `contacts/parties.json`,
  else `refused` with a text naming the party and saying to raise a
  capability question with a `first_contact` request. Nothing on `main`
  calls it after this spec but its test and the `contacts` commands; the
  `gh` shim does not (ADR 0014). Given a refusal, then the caller, not
  `checkContact`, writes spec 083's `refused` line; no caller exists yet.
- AC-9. **The `contacts` commands.** `panelator-scheduler contacts list`
  prints the parties with `approved_at`, `issue` and `question_comment_id`;
  `contacts remove <party>` does what spec 083 AC-2 says; `contacts log` is
  spec 083 AC-4's and is unchanged. No action kind writes
  `contacts/parties.json` (a test greps `src/actions/` for the path).
- AC-10. **The `gh` shim is unchanged.** `tools/scheduler/bin/gh` differs
  from `main` by nothing; a test asserts `gh issue create -R other/repo` from
  a stage reaches the mocked GitHub as the App's installation token would
  send it (so GitHub, not the shim, answers), and that the stage prompts of
  AC-14 say what a `404` on another repository means.
- AC-11. **The installation's scope is verified.** `checkInstallationScope(ctx)`
  in `src/contacts/scope.ts` calls `GET /app/installations` with the App JWT
  (through `createAppClient`'s octokit) and `GET /installation/repositories`
  with the installation token, and returns `ok` when there is exactly one
  installation, its `id` is `app.installation_id`, its `repository_selection`
  is `selected`, and the repository list is exactly the configured `repo`;
  else `failed: <reason>` naming the extra installations or repositories, or
  `all`. It runs at start-up after `botLogin()` (`bin/scheduler.ts`), and in
  the credential check's pre-run (AC-12). A failure is one notification per
  day while it lasts (gate `infra`, label `contact-scope`, the reason and
  "open the App's installation settings and set Only select repositories to
  adam26davidson/panelator"), logged with `channel` (AC-6), and does not stop
  the service (ADR 0014 says why). The `github-app-key` catalogue entry's
  `access` list gains the line "installed on adam26davidson/panelator only
  (repository_selection: selected)", so the credential check's
  least-privilege reading has the scope to judge against. Tests: a second
  repository in the mocked list fails with its name; `all` fails; the
  configured one alone passes; `GET /app` of spec 069 AC-2's probe is not
  called by the scope check (the probe's one-request test is unchanged).

**Credential check agent** (spec 030 AC-13, AC-14, as amended by spec 072)

- AC-12. **The credential check is a standing agent.**
  `agents/standing/credential-check.md`: standard tier, Claude, `worktree:
  none`, schedule `1d`, events `credential_expiry`, credentials none, actions
  `renew_credential`, output `credential-check-result`
  (`schemas/scheduler/credential-check-result.json` extends
  `standing-result.json` through `allOf` with an optional `warnings: [{ name,
  expires_at, steps }]`). Before its input is built the scheduler runs
  `runCheck` over every entry and `checkInstallationScope` (AC-11); the input
  is the catalogue joined with the index (set or missing, expiry, days left,
  last check, renew kind), those results, the pending `credential_expiry`
  events and the parties list; no secret and no plain-file list (spec 072
  AC-6). The agent returns, for each entry expiring within `warn_days` or
  failing its check, a `renew_credential { name }` action when `renew` has a
  `command`, else a warning; the scheduler sends one `credential-expiry`
  notification per warning with the entry's `setup` steps, once per
  credential per day (`src/standing/run.ts` applies `warnings` after the
  result is validated). It files a finding for each entry whose `used_by`
  names nothing and each `access` it judges wider than the uses it finds
  under `agents/` and `tools/scheduler/`, and a summary with the counts when
  nothing is wrong. The registry test covers the new agent.
- AC-13. **`renew_credential` is a level-1 action.** `agents/actions.yaml`
  gains `renew_credential` (`level: 1`), `src/actions/renew-credential.ts`
  joins `KINDS`: given an entry with `renew: { command }`, then `apply` runs
  the command through the entry's shim (`cred-exec.ts`, AC-2) with a
  timeout, then calls `runCheck`; on `ok` the index gets `expires_at` from
  the expiry probe; the undo is `null` with the reason "a rotated secret
  cannot be un-rotated". Given `renew` is `none` or `manual`, or the command
  or check fails, then the row is `failed` with the reason and one
  `credential-expiry` notification carries the setup steps. The test entry
  is the one renewable entry; the repository catalogue has none.

**Prompts and marks**

- AC-14. **The stages are told.** `agents/stages/plan.md`, `implement.md`,
  `fix.md`, `review.md` and `spec.md` carry one paragraph: the App's token
  reaches `adam26davidson/panelator` only; a `404` or `403` from `gh` or
  `git` on another repository means ask first, with a `first_contact`
  request, and a write there also needs a credential request; spec 067 AC-4's
  request paragraph is unchanged. `agents/standing/credential-check.md`'s
  prompt names the limits of AC-12.
- AC-15. **The earlier text is marked.** Spec 030 section 1 (the gate
  paragraph), AC-3, AC-8, AC-11 and section 5, and spec 083 AC-1, carry the
  marks of section 4; the earlier text follows unchanged.

## 4. Marks on earlier specs

- Spec 030 section 1, the paragraph "A first-contact gate in code": `Amended
  by 099 section 1: the gate for GitHub is the App installation's scope,
  verified by AC-11; the gh shim parses nothing (ADR 0014).`
- Spec 030 AC-3: `Amended by 099 AC-2: the shim calls
  tools/scheduler/bin/cred-exec.ts, a separate entry point that loads no
  registry or state; wrapper.command has no slash.`
- Spec 030 AC-8: `Amended by 099 AC-5: a first_contact approval is recorded
  but no channel can act on it yet, and the stage is told so; a credential
  "Done" whose check is skipped or whose name is not in the catalogue is
  answered as AC-5 says.`
- Spec 030 AC-11: `Superseded by 099 AC-8, AC-10 and AC-11:` the `gh`
  argument gate, its refusal and its test are replaced by the installation
  scope check; `checkContact` and the parties list stay as AC-8 gives them.
- Spec 030 section 5: `Amended by 099 section 5: bin/gh is unchanged;
  src/contacts/ gains scope.ts and loses the gate's shim call; bin/cred-exec.ts
  is new.`
- Spec 030 section 6, the recorded-run bullet for first contact: `Amended by
  099 section 6: the run is a first-contact question approved by button, the
  party registered, the resumed stage told no channel can reach the party,
  and no write to another repository attempted; the shim refuses nothing.`
- Spec 030 AC-13: `Amended by 099 AC-12: the credential check's pre-run
  gains checkInstallationScope and its result is part of the check's input.`
- Spec 083 AC-1: `Amended by 099 AC-8: the gh shim calls no gate and writes
  no refused line; the line's shape and writer stay for the first wrapper
  that calls checkContact.`

## 5. Interfaces and files

New or changed by the implementation, all under spec 030 section 5's rule
(nothing outside `tools/scheduler/`, `agents/`, `schemas/scheduler/`,
`dev-logs/` and `tools/README.md`):

- `tools/scheduler/src/credentials/shims.ts` (AC-2), `check.ts` (the
  producer's state and `credentials/expiry-state.json`, AC-3; `runCheck`
  unchanged), `catalogue.ts` (the `wrapper.command` pattern, AC-2);
  `tools/scheduler/bin/cred-exec.ts` (AC-2).
- `tools/scheduler/src/contacts/gate.ts` (AC-8), `approve.ts` (AC-5),
  `commands.ts` (AC-9), `scope.ts` (AC-11); `src/contacts/log.ts` unchanged.
- `tools/scheduler/src/notify/telegram.ts` (AC-6); `src/telegram/questions.ts`
  (the request rendering and keyboards, the alert reply, AC-4, AC-7);
  `src/telegram/poller.ts` and `answers.ts` (alert ids, button texts);
  `src/chain/driver.ts` and `src/chain/question.ts` (the pre-resume step of
  AC-5).
- `tools/scheduler/src/actions/renew-credential.ts` and `index.ts` (AC-13);
  `agents/actions.yaml`: `renew_credential` only.
- `tools/scheduler/src/runner/credentials.ts` and `run.ts`, `src/standing/run.ts`:
  the shim directory first on `PATH`, `credentials` for standing agents, the
  pre-run of AC-12, `warnings` as notifications.
- `tools/scheduler/src/profiles/resolve.ts`, `src/stages/definition.ts`,
  `src/types.ts`, `schemas/scheduler/profile.json`, `standing-definition.json`
  and `agents/profiles/{backend,design,security,spec}/profile.yaml` (AC-1).
- `tools/scheduler/src/service/loop.ts` and `bin/scheduler.ts`: the hourly
  step (AC-3), the notifier chain and `channel` (AC-6), the start-up scope
  check (AC-11), `contacts list|remove`.
- `tools/scheduler/src/state/paths.ts`: `contacts/parties.json`,
  `credentials/expiry-state.json`, `telegram/alerts.json`.
- `schemas/scheduler/`: `contacts.json`, `credential-check-result.json`,
  `question-log-entry.json` (`request`, `outcome`), `credential-catalogue.json`
  (the pattern), `action.json` if its kind list is closed (it is a free
  string today: nothing).
- `agents/credentials.yaml`: the one `access` line of AC-11;
  `agents/standing/credential-check.md` (AC-12); `agents/stages/*.md`
  (AC-14).
- `tools/scheduler/test/`: `credentials.test.ts` (AC-1 to AC-3, AC-13),
  `contacts.test.ts` (AC-5's approval, AC-8 to AC-11), `notify.test.ts`
  (AC-6, AC-7), `driver.test.ts` and `telegram.test.ts` (AC-4, AC-5), the
  registry test, `test/helpers/fakecmd`, and the recorded runs of section 6
  in `e2e.test.ts`.
- `tools/README.md`: `contacts list|remove`, `cred exec`, the scope check.

`tools/scheduler/`, `agents/` and `schemas/scheduler/` are sensitive paths;
the security review runs on the implementation PR (spec 006 AC-9). Nothing
here changes the sensitive-path list, the security criteria, what routes a
sensitive diff to the security review, design section 3, the lock rule or
the `maintainer` actor set of spec 008 AC-12, or any text marked as a
maintainer answer. The secret is read into memory for one exec, one check or
one renewal and is in no log line, run record, event payload, prompt or
stage environment (AC-2's tests). The shim directory and `cred-exec.ts` give
an agent no credential its profile does not list.

## 6. Verification

- `pnpm test` from the repository root passes and `pnpm -F
  @panelator/scheduler typecheck` is clean, with the tests of section 5 and
  recorded end-to-end runs for: a credential question with a complete
  request sent with `Done`/`Can't do this`, `Done` pressed, `runCheck` ok,
  the stage resumed with `done (verified)`, merged; the same with the check
  failing and a follow-up; a first-contact question approved by button, the
  party in `contacts/parties.json`, the stage resumed with the `approved
  (recorded; ...)` answer and no write to another repository attempted; an
  `infra` notification delivered to the chat and logged `channel: telegram`,
  and the same with the fake Telegram refusing, logged `channel: log`; a
  reply to an alert answered "alerts take no reply"; the credential check
  woken by `credential_expiry` for the test entry three days from expiry,
  one `credential-expiry` notification, nothing twice that day; a scope
  check failing on a second repository, one `contact-scope` notification;
  every earlier recorded chain unchanged with no `credentials` block and
  Telegram off.
- `git diff origin/main -- tools/scheduler/bin/gh` of the implementation PR
  is empty; `grep -rn "checkContact" tools/scheduler/src` finds `gate.ts`,
  `commands.ts` and nothing in `bin/`.
- On the laptop after deploy: `panelator-scheduler --check-auth` prints the
  scope as ok; `contacts list` prints `[]`; the first credential check run
  and the first Telegram alert are written up in `dev-logs/` with the service
  log lines carrying `channel`.

## 7. Open decisions

None.
