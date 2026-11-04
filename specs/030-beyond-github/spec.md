# 030. Reach beyond GitHub: credentials, funds, first contact, infra health

Status: written 2026-11-01 from the delivery-system design (spec F2) for
issue #39; specs derived from that design need no maintainer approval (design
section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Credentials", "Funds", "First contact", "Telegram carries
questions, credential and fund requests, first-contact requests, alerts and
reminders"), section 6.1 (infra health and credential check on the roster;
the `infra_alarm` and `credential_expiry` triggers), section 6.2 (level 1:
restart a service, scale within the cap, rotate a credential), section 3 item
3, section 11 (row F2) and section 2 (anti-goal: no contact with a new
outside party without approval); [charter](../../docs/charter.md) (work not
limited to GitHub; new credentials are requested proactively; funds may be
requested); [process-spec](../../docs/process-spec.md) 4.4 (the ops-watcher
slot) and 6.3; [001-scheduler-core](../001-scheduler-core/spec.md) section 12
(the `gh` wrapper and git credential helper); [006-no-human-stops](../006-no-human-stops/spec.md)
AC-8, AC-12, AC-13 and AC-15 (capability questions, the check, the pause, the
answer); [007-telegram-channel](../007-telegram-channel/spec.md) (the channel;
its section 2 leaves the `Notifier`, the store and the requests to this spec);
[008-agent-registry](../008-agent-registry/spec.md) AC-1 to AC-9, AC-11, AC-12
(standing agents, actions, the reserved events, `first_contact_needs_approval`);
[022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-6, AC-7 and
AC-9 (the ledger, the funds refusal, the forecast alarm) and its section 8
(the SSO session this spec's credential check watches);
[026-event-store](../026-event-store/spec.md) AC-2 (`maintainer.contact` kinds
`funds`, `credential`, `first_contact`).

What the maintainer decided (design section 8 and the issue), kept as it is
here: credentials live in an encrypted store on the laptop and agents use them
through wrappers, as with today's `gh` wrapper, never seeing the secret; a
request names the exact access needed and gives step-by-step setup; least
privilege; the credential check automates renewal where the provider allows;
funds are requested from the maintainer with the amount, the purpose and the
charter goal served; before first contact with any new outside party the agent
asks the maintainer who, why and what it would send, once approved later
contact with that party proceeds, and the locked parameter
`first_contact_needs_approval` stays on; an infra health agent watches alarms
and sweeps periodically, acts directly within limits and files findings; all
of these reach the maintainer through the Telegram channel of spec 007.

## 1. Goal

Give the system the four things that let it act outside GitHub without ever
handling a secret, spending unasked, or speaking to a stranger unasked:

- **A credential store and wrappers.** Every secret the system uses sits
  encrypted on the laptop under one directory, with a catalogue in the
  repository (`agents/credentials.yaml`) saying what each credential is for,
  the exact access it has, how its expiry is known and how it is renewed.
  Agents reach a credential only through a wrapper command on their `PATH`,
  generated from the catalogue the way the `gh` shim is written by hand
  today. The App key and the Telegram token move into the store.
- **Requests, with the right content, over Telegram.** A credential, funds
  or first-contact need raised by a chain stage is a capability question
  (spec 006) that must carry a `request` object with the fields the design
  names; the question check rejects one that does not. The scheduler acts on
  the answer: a first-contact approval registers the party; a credential
  "done" is verified by the credential's own check. Every `Notifier` alert
  (funds refusals, AWS thresholds, security advisories, agent failures) is
  sent to the Telegram chat as well as the service log.
- **A first-contact gate in code.** The one outbound channel that exists, the
  `gh` wrapper, refuses to create anything in a repository outside
  `adam26davidson/panelator` whose owner is not an approved party, and tells
  the agent how to ask. Later channels (email, support cases) plug into the
  same check.
- **Two standing agents.** The **credential check** runs daily and on
  `credential_expiry`: it probes every credential, warns the maintainer with
  the renewal steps days before an expiry, renews through `renew_credential`
  where the catalogue has a renewal command, and files findings for secrets
  outside the store or access wider than the catalogue says. **Infra health**
  wakes on `infra_alarm` and `ci_failure_main` and sweeps every six hours: it
  re-runs failed workflows, scales down what the ledger lets it scale when
  the forecast is over the cap, pauses an agent that keeps failing, and files
  a finding for everything it may not do itself.

## 2. Out of scope

- Any new outbound channel: email, AWS support cases, posting outside GitHub.
  No credential for one exists; the first spec that adds a channel adds its
  wrapper, its catalogue entry and a call to the gate of AC-11.
- Standing agents asking the maintainer directly. A standing agent that needs
  a credential, funds or a first contact files a finding (spec 008 AC-5); the
  filer files an issue and the chain's stage raises the question (AC-6). The
  scheduler's own funds request stays spec 022 AC-7, now delivered over
  Telegram (AC-9).
- A button that raises the AWS cap from Telegram. The cap is set by the
  maintainer's command (spec 008 AC-17) and the console (spec E); the funds
  message says which.
- Launching anything in AWS, and the console's hosting (spec E). Infra
  health scales only what a launcher has described in its reservation
  (AC-16); nothing is described until E lands.
- Intake and grilling over Telegram, group chats, a second maintainer (spec
  007 section 2, unchanged).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review; changing the lock rule or
  the `maintainer` actor set of spec 008 AC-12.
- The test board and firmware (spec G); the product's AWS account and
  hosting (product-spec 5.4, 5.5).

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API, the fake Telegram
server of spec 007 and the fake `aws` command of spec 022, plus a fake
`systemd-creds` on `PATH` (section 6) whose encrypt and decrypt are
reversible and whose output is written to a fixture directory. "Telegram
on" is spec 007's. *Store directory*: the `credentials.dir` of AC-1.

**The store and the catalogue** (design section 8, "Credentials")

- AC-1. **Secrets are encrypted at rest, outside the repository.**
  `agents/scheduler.yaml` gains a `credentials` block: `dir` (default
  `~/.config/panelator/credentials`), `warn_days` (default 7, min 1). The
  store directory holds one `<name>.cred` per credential, produced by
  `systemd-creds --user encrypt --name=<name>` (the key is the user's
  host-bound key, sealed to the TPM where there is one, so nothing beside the
  blob decrypts it), and `index.json`: per credential `name`, `created_at`,
  `set_by` (`maintainer` or `import`), `expires_at` (ISO time or `null`),
  `last_checked_at`, `last_check` (`ok`, `failed: <reason>` or `null`). The
  secret is decrypted only by `readSecret(name)` in
  `tools/scheduler/src/credentials/store.ts`, into memory, for the duration
  of one wrapper exec or one check; it is never written to the service log, a
  run record, an event payload, a stage's prompt, a stage's environment, or
  any file in the repository or the state directory. A test asserts each
  after a wrapped call and a check. `index.json` holds no secret; a test
  asserts the blob is not plaintext. Given the block is absent, then the
  defaults apply; given `dir` does not exist, then it is created with mode
  `0700` at the first `cred set`.
- AC-2. **The catalogue says what each credential is.** `agents/credentials.yaml`
  lists every credential the system knows, one entry each: `name`,
  `provider` (`github`, `telegram`, `aws`, ...), `purpose` (one line),
  `access` (the exact scopes or permissions, as a list of strings; least
  privilege is judged against it), `used_by` (stage profiles and standing
  agents), `wrapper` (`{ command, env }`: the command the shim wraps and the
  environment variable that command reads the secret from; or `none`),
  `expiry` (`none`; `index`: from `expires_at`; or `{ probe: <command> }`,
  a command run through the wrapper whose stdout gives the expiry as ISO
  time or the word `none`), `check` (a command run through the wrapper whose
  exit 0 means the credential works), `renew` (`none`, `manual` or `{
  command }`), and `setup` (a numbered list of steps the maintainer follows
  to create or renew it, in the words of a request). The initial entries:
  - `github-app-key`: the App private key (spec 001 section 12); access the
    App permissions of that section, listed; wrapper `none` (the scheduler
    reads it to mint `token.json`, as today); expiry `none`; check `gh api
    /app` through the existing `gh` shim; renew `manual`; setup the steps to
    generate a new key in the App's settings and run `cred set`;
  - `telegram-bot`: the bot token and chat id of spec 007 AC-1, stored as one
    JSON secret; wrapper `none`; expiry `none`; check `getMe`; renew `manual`;
    setup spec 007 section 8;
  - `aws-sso`: not a secret in the store but a catalogue entry for the SSO
    session of spec 022 section 8 (the AWS CLI owns it): wrapper `{ command:
    aws, env: AWS_PROFILE }` with the profile name as the "secret" (so the
    shim pins the profile and `--region` as spec 022 AC-1 requires); expiry
    `{ probe }` reading `expiresAt` from the matching file under
    `~/.aws/sso/cache/`; check `aws sts get-caller-identity`; renew `manual`
    (`aws sso login` needs a browser); setup the profile stanza and login of
    spec 022 section 8.

  Given an entry with an unknown key, a missing required key, a `wrapper`
  command already wrapped by another entry, or a `used_by` naming a profile
  or agent that does not exist, then loading fails as spec 008 AC-1 does, and
  the same checks run as a vitest test over the repository file. A profile's
  `credential_hook` field, unused since spec 001, is replaced by
  `credentials: [<name>, ...]`; a standing agent definition gains the same
  optional key; a name not in the catalogue fails loading.
- AC-3. **Wrappers are generated, and only they see the secret.** Given a
  stage or standing agent whose profile or definition lists credentials,
  then its `PATH` begins with a per-run directory holding one shim per
  listed credential with a `wrapper`: the shim calls the scheduler's
  `panelator-scheduler cred exec <name> -- <args>`, which reads the secret
  (AC-1), sets `env` to it in the child's environment only, and execs the
  real command found on the `PATH` after the shim directory, passing stdin,
  stdout, stderr and the exit status through. The existing `gh` shim and
  `git-credential-panelator.ts` keep reading `token.json` (the token is
  minted by the scheduler and refreshed every 50 minutes, as spec 001 says);
  the App key that mints it is read from the store once `github-app-key` is
  set, else from `app.private_key_path` as today. A stage or agent that
  lists no credentials gets only the `gh` shim and the helper, as today; the
  stage environment of spec 001 (`GH_TOKEN` empty, no SSH) is unchanged. A
  test asserts that the environment of a wrapped child carries the variable
  and the stage's own environment does not.
- AC-4. **The maintainer's commands.** `panelator-scheduler cred set <name>`
  reads the secret from stdin (never an argument, so it is not in the shell
  history), requires the name to be in the catalogue, encrypts it, writes
  the index entry with `set_by: maintainer`, runs the entry's `check` and
  prints the result. `cred list` prints each catalogue entry with its
  index state (set or missing, expiry, last check), never the secret. `cred
  check [<name>]` runs the checks and the expiry probes and updates the
  index. `cred import` reads `app.private_key_path` and
  `telegram.credentials_path` from the configuration, stores them as
  `github-app-key` and `telegram-bot` with `set_by: import`, and prints the
  two files to delete by hand; the configuration paths keep working while
  the files exist, and the credential check files one finding per plain
  file still present (AC-13). `cred remove <name>` deletes the blob and the
  entry. Every command runs as the user the service runs as and is logged
  in the action log with `agent: maintainer` (spec 008 AC-9), with
  `args.name` only.
- AC-5. **The expiry event has a producer.** Given a tick, at most once an
  hour, then for each credential whose `expires_at` (from the index, or the
  last probe) is within `warn_days`, or whose last check failed, the
  scheduler emits `credential_expiry` (spec 008 AC-4, until now with no
  producer) with `{ name, expires_at, last_check }`, once per credential per
  day, so the credential check runs (AC-13). A credential with expiry
  `none` never produces it.

**Requests from a chain stage** (design sections 3 and 8)

- AC-6. **A capability question for one of the three needs carries a
  request.** The question object of spec 006 AC-8 gains an optional
  `request`, required when the question is a credential, funds or
  first-contact need:
  - `{ type: "credential", name, provider, access: [..], setup: [..] }`:
    `name` a catalogue entry or a new name (then the spec PR or the
    implementing PR adds the entry), `access` the exact scopes, `setup` the
    numbered steps the maintainer follows, each a string;
  - `{ type: "funds", amount_usd, purpose, charter_goal }`: `charter_goal`
    quotes or names the charter clause served;
  - `{ type: "first_contact", party, channel, why, message }`: `party` a
    stable identifier (`github:<owner>`, `email:<address>`, `aws-support`),
    `channel` how it would be reached, `message` the full text that would be
    sent.

  Given a `question` result of kind `capability` whose text or request names
  a credential, funds or an outside party and whose `request` is missing or
  has an empty field, then the question check (spec 006 AC-12) returns
  `decide_yourself` with the reason "a <type> request must give <fields>",
  and the stage is in `decide` mode as today; `agents/stages/question-check.md`
  says so. Given a complete request, then the check judges the kind as
  before.
- AC-7. **The request is sent with its content and fixed buttons.** Given a
  sent question carrying a request (spec 007 AC-5), then the Telegram
  message and the issue comment render the request's fields as a labelled
  list (the setup steps numbered; the message that would be sent quoted in
  full), and the keyboard is: for `credential`, "Done" and "Can't do this";
  for `funds`, "Approved" and "Declined"; for `first_contact`, "Approve" and
  "Deny". The stage's own options are kept in the comment as the record but
  are not buttons. The `maintainer.contact` event recorded for the send
  (spec 026 AC-2) has `kind` equal to the request type instead of
  `question`, with the request in `payload.request`.
- AC-8. **The scheduler acts on the answer, then the stage resumes.** Given
  an answer (button or text) to a question with a request, then before the
  asking session resumes (spec 007 AC-13):
  - `first_contact`: given the "Approve" button, or a text whose first word
    is `approve`, `approved`, `yes` or `ok` (case-insensitive), then the
    party is appended to `contacts/parties.json` in the state directory
    (`party`, `channel`, `approved_at`, `question_comment_id`, `issue`) and
    the gate of AC-11 lets it through from then on; any other answer leaves
    the party unapproved, and the resumed stage may follow up (spec 006
    AC-15) or proceed without the contact. A `maintainer.contact` event
    `kind: first_contact` with `payload.outcome` `approved` or `denied` is
    recorded.
  - `credential`: given "Done" or a text starting `done`, then the scheduler
    runs the catalogue entry's `check` (and `cred check <name>`'s index
    update); given it passes, the answer the stage receives is `done
    (verified)`; given it fails, the answer is `done (check failed:
    <reason>)`, so the stage asks a follow-up with the failing step rather
    than building on a broken credential. A `maintainer.contact` event
    `kind: credential` with the outcome is recorded.
  - `funds`: the answer is passed through; a `maintainer.contact` event
    `kind: funds` with `payload.outcome` (`approved`, `declined` or `text`)
    is recorded. Spending the funds is the maintainer's action (for AWS, the
    two steps of spec 022 section 8, step 3).

  The answer is still posted to the issue and logged as spec 007 AC-9 says;
  nothing else in the pause, resume or record path changes.

**Alerts over Telegram** (design section 8, "Telegram carries ... alerts")

- AC-9. **Every notification reaches the chat.** Given Telegram on, then the
  service's `Notifier` is a `TelegramNotifier` wrapping the `LogNotifier`
  and the rate limiter of spec 001: every notification is written to the
  service log as today and then sent to the chat as one message headed by
  its gate and label (`aws-funds`, `aws-cap-hit`, `aws-forecast`,
  `aws-access`, `infra`, `chain_error`, a standing agent's failure, a
  security advisory of spec 008 AC-22, and every later label), with the
  issue number when there is one, no buttons, and no agent text beyond the
  notification's own. The `maintainer.contact` event for it has `channel:
  telegram` (`log` when Telegram is off or the send failed). Given the send
  fails, then the log line stands, the failure is logged once per outage,
  and nothing is retried: alerts are not questions. The rate limit of spec
  001 applies before the send, so the chat gets no more than the log does
  today. A `funds` notification (spec 022 AC-7) is sent with the request
  fields of AC-6 laid out as in AC-7, without buttons, and its event keeps
  `kind: funds`.
- AC-10. **A reply to an alert is not an answer.** Given a Telegram message
  that replies to an alert message, then it is not matched to any question
  (spec 007 AC-7 matches only question threads); the bot replies once that
  alerts take no reply and lists the open questions, if any, as `/questions`
  does.

**The first-contact gate** (design section 8, "First contact")

- AC-11. **No outbound contact without an approved party, in code.**
  `checkContact(ctx, party)` in `tools/scheduler/src/contacts/gate.ts`
  returns `allowed` when `first_contact_needs_approval` is `false`, or when
  `party` is in `contacts/parties.json`; else `refused` with a text that
  names the party and says to raise a capability question with a
  `first_contact` request (AC-6). Every wrapper that can reach an outside
  party calls it before the call; in this spec that is the `gh` shim: given
  an invocation that would create or edit content in a repository other
  than the configured `repo` (`gh issue create`, `gh pr create`, `gh issue
  comment`, `gh pr comment`, `gh pr review`, `gh api` with a method other
  than `GET` against `/repos/<other>/...`, `gh repo fork`, and any
  `--repo`/`-R` naming another repository), then the shim calls
  `checkContact` with `github:<owner>` and, when refused, exits 1 with the
  text and makes no call; reads and every call against the configured
  repository are unchanged. A refused call is recorded in the action log
  (`agent: <stage or agent>`, `kind: contact_refused`, `status: refused`,
  the party and the command without its body) so the action audit and the
  console can see attempts. The parameter is read from the store at each
  call; the system cannot change it (spec 008 AC-12). A test asserts a
  `gh issue create -R other/repo` is refused and makes no API call, and the
  same call after an approval of AC-8 goes through.
- AC-12. **Approved parties are visible and only the maintainer removes
  them.** `panelator-scheduler contacts list` prints the parties with their
  approval time, issue and question id; `contacts remove <party>` deletes an
  entry and is logged as `maintainer`. No action kind writes
  `contacts/parties.json`; a test asserts it.

**Credential check agent** (design section 6.1)

- AC-13. **The credential check is a standing agent.**
  `agents/standing/credential-check.md`: standard tier, Claude, `worktree:
  none`, schedule `1d`, events `credential_expiry`, credentials none,
  actions `renew_credential`, output `standing-result`. Its input is the
  catalogue joined with the index (set or missing, expiry, days left, last
  check, renew kind), the result of `cred check` run by the scheduler just
  before (the agent does not hold the secrets), the plain configuration
  files still present (AC-4), the pending `credential_expiry` events, and
  the parties list. It returns:
  - for each credential expiring within `warn_days` or failing its check:
    when `renew` has a `command`, a `renew_credential { name }` action; else
    one finding is not enough, so the agent's result carries
    `warnings: [{ name, expires_at, steps }]` (its output schema
    `credential-check-result` adds the field), and the scheduler sends one
    notification per warning with label `credential-expiry`, carrying the
    entry's `setup` steps, so the maintainer gets the renewal steps over
    Telegram (AC-9) before the expiry, once per credential per day;
  - a finding for each plain file still in use after `cred import`, for
    each credential whose `used_by` names nothing (unused access), and for
    each catalogue `access` the agent judges wider than the uses it finds in
    `agents/` and `tools/scheduler/` (least privilege), with the evidence;
  - a summary saying "all credentials checked" with the counts when nothing
    is wrong.
- AC-14. **Renewal is an action.** `renew_credential { name }` is a level-1
  kind in `agents/actions.yaml`: given an entry with `renew: { command }`,
  then the scheduler runs the command through the entry's wrapper with a
  timeout, re-runs `check`, and on success rewrites the index entry
  (`expires_at` from the probe, `last_check: ok`); the undo is `null` (a
  rotated secret cannot be un-rotated; the log says so). Given `renew` is
  `none` or `manual`, or the command or check fails, then the action is
  `failed` with the reason and a `credential-expiry` notification carries
  the setup steps. The initial catalogue has no renewable entry; the kind
  exists so the first provider that allows renewal (a token with a refresh
  endpoint) needs only a catalogue entry.

**Infra health agent** (design sections 6.1 and 6.2; process-spec 4.4)

- AC-15. **Infra health is a standing agent.** `agents/standing/infra-health.md`:
  standard tier, Claude, `worktree: none`, schedule `6h`, events
  `infra_alarm` and `ci_failure_main`, credentials `aws-sso`, actions
  `rerun_workflow`, `run_agent`, `pause_agent`, `aws_scale`, output
  `standing-result`. Its input is the pending events with their payloads
  (spec 022 AC-9's forecast alarm, spec 015's outage alarm, the `main`
  check failure), `aws/cost.json`, the open reservations of the ledger with
  their `scale` descriptors (AC-16), the standing agents' state files
  (consecutive failures, paused), the last 24 hours of the service log's
  tick summaries, and the action log of the last 7 days. The sweep reads
  only; the agent itself has no `aws` write action beyond `aws_scale`. Its
  prompt sets the limits: it may re-run a failed `main` workflow once per
  run id (the kind's own bound), scale down a reservation when the forecast
  is over the cap and scale it back when under, pause a standing agent with
  three consecutive failures, and must file a finding (not act) for a
  resource it cannot scale, a cost it cannot explain against the ledger, an
  outage past the `infra` alarm, or anything needing a reviewed PR, funds, a
  credential or a first contact. Given nothing is wrong, then the summary
  says so and no action is requested.
- AC-16. **Scaling is an action bounded by the ledger.** A reservation of
  spec 022 AC-6 gains an optional `scale` descriptor, written by the
  launcher: `{ kind, id, down, up }` with `kind` one of the kinds coded in
  `tools/scheduler/src/actions/aws-scale.ts` (`lambda-concurrency`,
  `cloudfront-distribution`, `dynamodb-throughput`; the kinds ADR 0005's
  console will launch) and `down`/`up` the kind-specific values. `aws_scale
  { reservation_id, direction }` is a level-1 kind: given an open
  reservation with a descriptor, then the scheduler runs the kind's `aws`
  call through `src/aws/cli.ts` (the one place `aws` is spawned, spec 022
  AC-6's grep test still passes), records the direction in the reservation,
  and lowers `expected_monthly_usd` to the descriptor's `down` cost while
  down; the undo is the opposite direction. Given a reservation without a
  descriptor, a released one, or a direction it is already in, then the
  action is refused with the reason. The kinds' calls are tested against the
  fake `aws`.
- AC-17. **The scheduler's own service is a resource too.** `restart_service`
  is not an action kind: the scheduler is the only service and restarts
  itself after merges (spec 008 AC-2). Infra health files a finding when the
  tick summaries show the service restarting more than three times in 24
  hours, with the log lines as evidence.

## 4. Design notes (agent's calls)

- **`systemd-creds --user`, not a passphrase store.** Design section 8 asks
  for an encrypted store on a laptop that runs a user service unattended, so
  nothing may prompt. The three stores on this laptop: `secret-tool`
  (GNOME keyring) is locked after a reboot until the user logs in; GPG or
  `age` with the identity in a `0600` file beside the data is encryption in
  name only; `systemd-creds --user` (systemd 261 here, TPM2 present) seals
  each blob to the user's host key and the TPM, decrypts without a prompt,
  and leaves nothing on disk that decrypts it. The catalogue stays in the
  repository because it holds no secret and is exactly the "exact access"
  and "step-by-step setup" a request must quote. Not an ADR: a handful of
  secrets re-encrypt in a minute if the store changes.
- **The same uid, so the wrapper is the convention and the review is the
  guard.** Agents run as the service's user, as today with `token.json`;
  the store does not change that. What it changes is that no plaintext
  secret sits in a file an agent would naturally read, no environment
  variable carries one, and the wrapper is the only documented path. The
  security review of `tools/scheduler/` and `agents/` and the credential
  check's findings are what keeps it so.
- **Requests ride the capability question, not a second channel.** Spec 006
  and 007 already pause, check, send, button, resume and record a question;
  the design lists credentials, funds and first contact as the third kind
  of question. Adding a `request` object gives the check something concrete
  to require and the scheduler something concrete to act on. Standing
  agents keep to findings (spec 008 AC-5): the one place that needs the
  answer in code is the chain stage that will use it.
- **Approval is a button or a plain word, recorded by code.** The design
  says later contact "proceeds" once approved, which needs a record the
  gate can read without an agent's judgement. A fixed keyboard and a short
  list of accepting first words make the record a scheduler decision; any
  richer reply goes to the asking session, which is spec 007's point.
- **The `gh` shim is the first gate because it is the only door.** Every
  outbound action the system can take today goes through `gh`; an email or
  a support case needs a credential that does not exist yet and will add its
  own door. Putting `checkContact` in the shim makes the anti-goal of design
  section 2 a refusal with an exit code rather than an instruction.
- **Alerts are one-way.** Spec 007 made questions a conversation; a `funds`
  refusal or a cap alert needs nothing back through the system (the
  maintainer acts with the command line or the console), so the
  `TelegramNotifier` is a sink and a reply to it is told so.
- **Infra health scales only what was described at launch.** The design's
  "within limits that already exist" and spec 022's ledger meet in the
  `scale` descriptor: the launcher that stated a cost also states how to
  make it smaller, and the agent can only ever move between the two states
  the launcher wrote down. With no launcher yet, the kinds coded are ADR
  0005's, so spec E's implementation has them ready.

## 5. Interfaces and files

- `tools/scheduler/src/credentials/`: `catalogue.ts` (`agents/credentials.yaml`,
  its checks, AC-2), `store.ts` (`readSecret`, `writeSecret`, `index.json`,
  the `systemd-creds` spawn with the command path injectable, AC-1),
  `shims.ts` (the per-run shim directory, AC-3), `check.ts` (checks, probes,
  the `credential_expiry` producer, AC-4, AC-5), `commands.ts` (`cred set`,
  `list`, `check`, `import`, `remove`, `exec`, AC-3, AC-4).
- `tools/scheduler/src/contacts/`: `gate.ts` (`checkContact`,
  `contacts/parties.json`, AC-11), `commands.ts` (AC-12), `approve.ts` (the
  answer handling of AC-8).
- `tools/scheduler/src/notify/telegram.ts`: `TelegramNotifier` (AC-9);
  `src/telegram/questions.ts`: request rendering and the fixed keyboards
  (AC-7), the alert-reply response (AC-10); `src/telegram/poller.ts`:
  alert message ids kept so replies to them are recognised.
- `tools/scheduler/src/chain/driver.ts` and `src/chain/question.ts`: the
  request in the comment (AC-7), the pre-resume step of AC-8;
  `src/decide/` (the question check's input and the `decide_yourself`
  reason of AC-6).
- `tools/scheduler/src/actions/`: `renew-credential.ts` (AC-14),
  `aws-scale.ts` (AC-16), `contact-refused` log entries (AC-11);
  `agents/actions.yaml` gains `renew_credential` and `aws_scale`.
- `tools/scheduler/src/aws/ledger.ts`: the `scale` descriptor, the lowered
  cost while down (AC-16); `src/aws/cli.ts` unchanged as the one spawn.
- `tools/scheduler/src/runner/credentials.ts` and `src/runner/run.ts`: the
  shim directory first on `PATH`, the App key from the store (AC-3);
  `src/standing/run.ts`: credentials for standing agents.
- `tools/scheduler/src/profiles/resolve.ts`, `src/stages/definition.ts`,
  `src/types.ts`: `credentials` replaces `credential_hook` (AC-2).
- `tools/scheduler/src/service/loop.ts`: the hourly expiry step, the
  `TelegramNotifier` wiring, the `funds` notification layout (AC-5, AC-9).
- `tools/scheduler/src/config.ts` and `agents/scheduler.yaml`: the
  `credentials` block (AC-1).
- `tools/scheduler/src/state/paths.ts`: `contacts/parties.json`.
- `tools/scheduler/src/events/kinds.ts` and `schemas/scheduler/event.json`:
  `payload.request` and `payload.outcome` on `maintainer.contact`;
  `channel: telegram` for notifications (AC-7 to AC-9).
- `tools/scheduler/bin/gh`: the gate (AC-11); `bin/scheduler.ts`: the
  `cred` and `contacts` commands.
- `agents/credentials.yaml` (AC-2); `agents/profiles/*/profile.yaml`:
  `credentials` in place of `credential_hook`; `agents/standing/credential-check.md`
  and `agents/standing/infra-health.md` (AC-13, AC-15);
  `agents/stages/question-check.md`: the request requirement (AC-6);
  `agents/stages/plan.md`, `implement.md`, `fix.md`, `review.md`, `spec.md`:
  one paragraph on the `request` object a credential, funds or first-contact
  question must carry, and that a refused `gh` call means "ask first".
- `schemas/scheduler/`: `credential-catalogue.json`, `credential-index.json`,
  `contacts.json`, `credential-check-result.json`, `question.json` (the
  `request` object, shared by every stage's result schema and the paused
  record), `aws-ledger.json` (`scale`), `standing-definition.json` and
  `profile.json` (`credentials`), `action.json` (the two kinds).
- `tools/scheduler/test/`: `credentials.test.ts` (store, catalogue checks,
  shims, commands, expiry producer, secrets never logged, AC-1 to AC-5),
  `contacts.test.ts` (gate, the `gh` shim refusals, approval, commands,
  AC-8, AC-11, AC-12), `notify.test.ts` (the Telegram notifier, alert
  replies, AC-9, AC-10), `question-check.test.ts` and `driver.test.ts`
  (AC-6 to AC-8), `actions.test.ts` (the two kinds, AC-14, AC-16), the
  registry test over the two new agents, and the recorded runs of section 6
  in `e2e.test.ts`; the fake `systemd-creds` under `test/helpers/`.
- `tools/README.md`: the `cred` and `contacts` commands, the `credentials`
  block, the catalogue (documentation of the tool, in its own package).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed by the implementation except `tools/README.md`.
`tools/scheduler/` and `agents/` are sensitive paths, so the security review
runs on the PR as spec 006 AC-9 says. Nothing here changes the sensitive-path
list, the security criteria, or what routes a sensitive diff to the security
review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the catalogue test over `agents/credentials.yaml` and the registry test
    over the two new agents (AC-2, AC-13, AC-15);
  - the secrets-never-logged assertions after a wrapped call, a check and a
    renewal (AC-1, AC-3, AC-14);
  - recorded end-to-end runs (fake adapter, mocked GitHub, fake Telegram,
    fake `aws`, fake `systemd-creds`) for: a credential question with a
    complete request sent with "Done"/"Can't" buttons, "Done" pressed, the
    check passing, the stage resumed with `done (verified)`, merged; the
    same with the check failing and a follow-up; a credential question
    without `setup` sent back by the check as `decide_yourself`; a
    first-contact question approved by button, the party registered, a `gh
    issue create -R other/repo` from the resumed stage going through, and
    the same call refused before approval with one `contact_refused` log
    entry; a funds refusal from spec 022 delivered to the chat with the
    request layout and recorded `channel: telegram`; a reply to an alert
    answered "alerts take no reply"; the credential check woken by
    `credential_expiry` for `aws-sso` three days from expiry, one
    `credential-expiry` notification with the login steps, nothing twice
    that day; infra health woken by `aws_forecast_over_cap`, scaling down a
    reservation with a descriptor, the forecast falling under, scaling it
    back; infra health re-running a failed `main` workflow and filing a
    finding for a reservation without a descriptor; every earlier recorded
    chain (specs 006, 007, 008, 013, 022, 026) unchanged with no
    `credentials` block and Telegram off.
- On the laptop, after `cred import` and `cred set` for the two existing
  secrets, `panelator-scheduler cred check` exits 0 for all three catalogue
  entries and `telegram-check` and `aws-check` still pass; the implement
  stage runs them and quotes the output in the PR. Importing is the
  maintainer's step (the files are theirs); the implement stage raises it as
  a capability question with the `cred import` command and the two files to
  delete when it reaches this step and the index is empty.
- After the service is restarted on the merged code, the first real
  Telegram alert, the first credential check run and the first infra health
  run are written up in `dev-logs/` with their run records and the
  `maintainer.contact` events.

## 7. Open decisions

None.
