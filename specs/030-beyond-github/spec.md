# 030. Reach beyond GitHub: credentials, funds, first contact, infra health

Status: written 2026-11-01 from the delivery-system design (spec F2) for
issue #39; specs derived from that design need no maintainer approval (design
section 11). Revised 2026-11-04 in answer to the plan stage: the spec was
written as if specs 022 (issue #37, labelled `blocked`) and 026 (issue #93)
were on `main`; neither has an implementation branch. This spec now builds
only on what `main` has (specs 001 to 021, 023 to 025, 029) and needs
nothing else on `main`. Its AWS half and its event recording are set out
in section 2 and section 4 ("Why this spec is split") for the follow-up
spec (row F2, second part) that derives from specs 022 and 026 once they
are built; no acceptance criterion kept here changes its meaning. *(agent's
call)* Revised 2026-11-05 after the implementation's fix loop ran out: three
review rounds each found a `gh` form that AC-11's enumerated list and a
positional parser let through or wrongly refused, one found that AC-6's "text
names a credential" had become a word list that misread a physical-action
question, and one read AC-4's "every command" as excluding `list`. AC-11 now
states the gate as a token rule that fails closed, AC-6 leaves the judgement
of a request-less question to the question check and gives the scheduler
only a completeness check, AC-4 names `list`, and section 5 lists every file
the implementation touched so the plan's file scope is complete. *(agent's
call)*
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
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) AC-8 (the
`infra_alarm` producer that exists today);
[022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-6, AC-7 and
AC-9 (the ledger, the funds refusal, the forecast alarm) and its section 8
(the SSO session), and [026-event-store](../026-event-store/spec.md) AC-2
(`maintainer.contact` kinds `funds`, `credential`, `first_contact`): both
named only so that what this spec leaves to the follow-up spec (section 2)
fits them; nothing here needs either on `main`.

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
  (outages, chain errors, security advisories, agent failures, and the AWS
  alerts once spec 022 produces them) is sent to the Telegram chat as well
  as the service log.
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
  re-runs failed workflows, pauses an agent that keeps failing, notices a
  service that keeps restarting, and files a finding for everything it may
  not do itself. Its AWS half (scaling what the ledger lets it scale when the
  forecast is over the cap) is the follow-up spec's, once spec 022 exists.

## 2. Out of scope

- Any new outbound channel: email, AWS support cases, posting outside GitHub.
  No credential for one exists; the first spec that adds a channel adds its
  wrapper, its catalogue entry and a call to the gate of AC-11.
- Standing agents asking the maintainer directly. A standing agent that needs
  a credential, funds or a first contact files a finding (spec 008 AC-5); the
  filer files an issue and the chain's stage raises the question (AC-6). The
  scheduler's own funds request stays spec 022 AC-7; the follow-up spec lays
  it out over Telegram.
- A button that raises the AWS cap from Telegram. The cap is set by the
  maintainer's command (spec 008 AC-17) and the console (spec E); the funds
  message says which.
- Launching anything in AWS, and the console's hosting (spec E).
- **Everything that needs spec 022 or spec 026 on `main`** *(agent's call;
  section 4, "Why this spec is split")*. These are the follow-up spec's, row
  F2's second part, derived from this spec, spec 022 and spec 026, and built
  once both are on `main`:
  - the `aws-sso` catalogue entry (the SSO session of spec 022 section 8:
    wrapper `{ command: aws, env: AWS_PROFILE }` with the profile name as
    the "secret", expiry `{ probe }` reading `expiresAt` from the matching
    file under `~/.aws/sso/cache/`, check `aws sts get-caller-identity`,
    renew `manual`, setup the profile stanza and login of spec 022 section
    8), with every `aws` spawn of a `provider: aws` entry going through
    `src/aws/cli.ts` (AC-2 here fixes that rule), and the `aws-sso` expiry
    run of the credential check (one `credential-expiry` notification with
    the login steps three days before the session ends);
  - the `maintainer.contact` events of spec 026 AC-2 for a request's send
    and answer (`kind` equal to the request type, `payload.request`,
    `payload.outcome` `approved`, `denied`, `declined`, `verified`,
    `check_failed` or `text`) and for a notification (`channel: telegram`,
    or `log` when Telegram is off or the send failed), in
    `tools/scheduler/src/events/kinds.ts` and `schemas/scheduler/event.json`,
    with spec 026's recording wrapper placed between the rate limiter and
    the `TelegramNotifier` of AC-9 so a suppressed notification is not a
    contact;
  - the `funds` notification of spec 022 AC-7 laid out with the request
    fields of AC-6 as AC-7 renders them, without buttons, its event keeping
    `kind: funds`; the AWS labels (`aws-funds`, `aws-cap-80`, `aws-cap-hit`,
    `aws-forecast`) need nothing: AC-9 forwards every label;
  - infra health's AWS half: credentials `aws-sso`; the action `aws_scale {
    reservation_id, direction }` (level 1, `tools/scheduler/src/actions/aws-scale.ts`,
    kinds `lambda-concurrency`, `cloudfront-distribution`,
    `dynamodb-throughput`, the kinds ADR 0005's console will launch; its
    `aws` call through `src/aws/cli.ts`; the undo the opposite direction;
    refused for a reservation without a descriptor, a released one, or a
    direction it is already in); the optional `scale` descriptor `{ kind,
    id, down, up }` on a reservation of spec 022 AC-6, written by the
    launcher, with `expected_monthly_usd` lowered to `down` while down;
    `aws/cost.json` and the open reservations in the agent's input; the
    `aws_forecast_over_cap` payload of spec 022 AC-9 among the alarms it
    handles; the limits "scale down a reservation when the forecast is over
    the cap and scale it back when under" and the findings for a resource
    it cannot scale or a cost it cannot explain against the ledger.

  The follow-up is its own issue (section 4 says how it is filed). Nothing
  in this spec is written so that it has to change when the follow-up lands:
  the request object, the notifier, the catalogue rule for `provider: aws`
  and the infra health prompt's shape are fixed here.
- The disk-space sweep of issue #124 (inodes and free space on the temp and
  state volumes, checked inside the scheduler's own process). That issue
  asks for its own spec; the infra health agent of AC-15 is the agent it
  would extend, and this spec neither builds that sweep nor rules it out.
- Intake and grilling over Telegram, group chats, a second maintainer (spec
  007 section 2, unchanged).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review; changing the lock rule or
  the `maintainer` actor set of spec 008 AC-12.
- The test board and firmware (spec G); the product's AWS account and
  hosting (product-spec 5.4, 5.5).

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API and the fake
Telegram server of spec 007, plus a fake `systemd-creds` on `PATH` (section
6) whose encrypt and decrypt are reversible and whose output is written to a
fixture directory. No `aws` command, real or fake, is needed by anything in
this spec. "Telegram on" is spec 007's. *Store directory*: the
`credentials.dir` of AC-1.

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
  - no `aws` entry yet *(agent's call)*: the `aws-sso` entry for the SSO
    session of spec 022 section 8 is the follow-up spec's (section 2), since
    the session, the profile, the fake `aws` and `src/aws/cli.ts` are all
    spec 022's and none exists on `main`. The rule it will follow is fixed
    here so the two specs' tests cannot contradict each other: for an entry
    with `provider: aws`, the `check`, the `expiry.probe` and the shim's
    `cred exec` are all run through `src/aws/cli.ts`, the one place spec 022
    AC-1 spawns `aws` (with `--profile`, `--region`, `--output json` and a
    timeout), not by `cred exec`'s own spawn; so spec 022 AC-6's grep for
    `aws` invocations outside `src/aws/` keeps passing, and a wrapper exec is
    not exempt from it. `cred exec` spawns the catalogue command itself only
    for other providers.

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
  entry. Every command runs as the user the service runs as, and every
  maintainer command, `cred list` and `contacts list` included, is logged in
  the action log with `agent: maintainer` (spec 008 AC-9), `kind:
  cred_<command>` or `contacts_<command>`, and `args` holding `name` when
  the command has one and nothing else: never the secret. `cred exec` is the
  wrapper's path, not a maintainer command, and is not logged, as the `gh`
  shim's token read is not. A test asserts one row each for a `cred list`,
  `cred set`, `cred check` and `contacts list` run.
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

  Two checks, and only these, enforce it *(agent's call, 2026-11-05)*:
  - **In code, completeness of a request the stage set.** Given a `question`
    result whose `request` is present and has a missing or empty field (an
    empty string, an empty list or a list with an empty string, `amount_usd`
    not above zero), then the scheduler returns `decide_yourself` to the
    stage before any question check runs, with the reason "a <type> request
    must give <missing fields>", and the stage is in `decide` mode as today.
    The result schema accepts the empty fields so that this path, not an
    `invalid` result, is what the stage sees. The scheduler classifies
    nothing from the question's text: no word list, no pattern over the
    question, the options or the recommendation decides whether a question
    is a credential, funds or first-contact need. (A question such as "I
    need physical access to the test board" is a capability question the
    maintainer answers, and must reach them.)
  - **By the question check, absence of a request.** Given a `question` of
    kind `capability` with no `request` that is, in the check's judgement, a
    credential, funds or first-contact need, then the question check (spec
    006 AC-12) returns `decide_yourself` with the reason "a <type> request
    must give <fields>" naming the type's fields; `agents/stages/question-check.md`
    says so, with the three field lists. Given a complete request, then the
    check judges the kind as before, and the check's input carries the
    request so it can judge it.
- AC-7. **The request is sent with its content and fixed buttons.** Given a
  sent question carrying a request (spec 007 AC-5), then the Telegram
  message and the issue comment render the request's fields as a labelled
  list (the setup steps numbered; the message that would be sent quoted in
  full), and the keyboard is: for `credential`, "Done" and "Can't do this";
  for `funds`, "Approved" and "Declined"; for `first_contact`, "Approve" and
  "Deny". The stage's own options are kept in the comment as the record but
  are not buttons. The question log entry of spec 006 AC-18 carries the
  request as `request`, so the record has it before spec 026's events exist;
  the `maintainer.contact` event for the send (`kind` equal to the request
  type, `payload.request`) is the follow-up spec's (section 2). *(agent's
  call)*
- AC-8. **The scheduler acts on the answer, then the stage resumes.** Given
  an answer (button or text) to a question with a request, then before the
  asking session resumes (spec 007 AC-13):
  - `first_contact`: given the "Approve" button, or a text whose first word
    is `approve`, `approved`, `yes` or `ok` (case-insensitive), then the
    party is appended to `contacts/parties.json` in the state directory
    (`party`, `channel`, `approved_at`, `question_comment_id`, `issue`) and
    the gate of AC-11 lets it through from then on; any other answer leaves
    the party unapproved, and the resumed stage may follow up (spec 006
    AC-15) or proceed without the contact.
  - `credential`: given "Done" or a text starting `done`, then the scheduler
    runs the catalogue entry's `check` (and `cred check <name>`'s index
    update); given it passes, the answer the stage receives is `done
    (verified)`; given it fails, the answer is `done (check failed:
    <reason>)`, so the stage asks a follow-up with the failing step rather
    than building on a broken credential.
  - `funds`: the answer is passed through. Spending the funds is the
    maintainer's action (for AWS, the two steps of spec 022 section 8, step
    3).

  The outcome (`approved`, `denied`, `verified`, `check_failed`, `declined`
  or `text`) is written into the question log entry's `answer` record of
  spec 007 AC-9 as `outcome`, and the answer is still posted to the issue and
  logged as that AC says; nothing else in the pause, resume or record path
  changes. The `maintainer.contact` events for these outcomes are the
  follow-up spec's (section 2). *(agent's call)*

**Alerts over Telegram** (design section 8, "Telegram carries ... alerts")

- AC-9. **Every notification reaches the chat.** Given Telegram on, then the
  service's `Notifier` is a `TelegramNotifier` wrapping the `LogNotifier`
  and the rate limiter of spec 001: every notification is written to the
  service log as today and then sent to the chat as one message headed by
  its gate and label (every gate and label the code sends today: `infra`,
  `chain_error`, `abandoned`, `standing` for a standing agent's failure, a
  security advisory of spec 008 AC-22, the `credential-expiry` label of
  AC-13, and every later label, so spec 022's `aws-*` labels need nothing
  here), with the issue number when there is one, no buttons, and no agent
  text beyond the notification's own. The notifier takes no part in what the
  text says: the layout of a `funds` notification is the follow-up spec's
  (section 2), as is the `maintainer.contact` event with `channel:
  telegram`. The wiring order is fixed here so that spec 026's recording
  wrapper has a place: `rateLimited(TelegramNotifier(LogNotifier))`, the
  recorder going between the rate limiter and the `TelegramNotifier` when
  spec 026 lands. Given the send fails, then the log line stands, the
  failure is logged once per outage, and nothing is retried: alerts are not
  questions. The rate limit of spec 001 applies before the send, so the chat
  gets no more than the log does today. The service log line for a sent
  notification gains `channel: telegram` (`log` when Telegram is off or the
  send failed), so the first real alert of section 6 can be shown.
  *(agent's call)*
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
  party calls it before the call; in this spec that is the `gh` shim. The
  shim's rule is stated over tokens, not over a list of subcommands, and it
  fails closed *(agent's call, 2026-11-05; section 4, "The gate reads
  tokens")*:
  - **Which calls reach the gate.** The runner sets `PANELATOR_SCHEDULER`
    (the scheduler's entry point) in every stage's and standing agent's
    environment. The shim runs `panelator-scheduler contacts gate -- "$@"`
    for every invocation in which any argument contains a `/`: every way of
    naming a repository (`owner/repo`, a URL, an API path) does, so no shell
    pattern over subcommands is needed and none is written. Given
    `PANELATOR_SCHEDULER` is unset and an argument contains a `/`, then the
    shim exits 1 saying the gate is unavailable, as it exits today when
    `token.json` has no token. An invocation with no `/` in any argument is
    passed to `gh` unchanged.
  - **How the gate finds repositories.** `classifyGh(argv, repo)` in
    `gate.ts` scans every argument, in any position, for a repository
    reference: the value of `-R` or `--repo` (as the next token, as
    `--repo=<value>`, or attached as `-R<value>`); any token containing
    `github.com/<owner>/<repo>` (with or without a scheme, `www.` or `api.`,
    whatever follows: an issue, pull request, repository or API URL); any
    token matching `repos/<owner>/<repo>` with or without a leading `/`
    (an API path); and the `<owner>/<repo>` positional of `gh repo <verb>`.
    `{owner}`, `{repo}`, `:owner` and `:repo` are gh's placeholders for the
    current repository and resolve to the configured `repo`. The comparison
    with the configured `repo` is case-insensitive. A call that references
    no repository other than the configured one is **allowed** without a
    further look, so reads and every call against the configured repository
    are unchanged.
  - **Which of those are reads.** A call that references another repository
    is allowed only when it is a read: the subcommand's verb (the second
    positional word, `gh <group> <verb>`) is one of `view`, `list`, `status`,
    `diff`, `checks`, `download`, `clone`, `browse`, `search`; or the group
    is `api` and no token sets a method other than `GET` (`-X` or
    `--method` as the next token, with `=`, or attached as `-X<value>`) and
    no token is a body flag (`-f`, `-F`, `--field`, `--raw-field`,
    `--input`, as a token or attached as `-f<value>`). The group and the
    verb are the first two tokens of `argv`; given either starts with `-`,
    then the verb is unknown and the call is not a read. No token is
    skipped as "a flag's value": every token is scanned for the shapes
    above, so a header, a `--jq` program or a `--hostname` before an API
    path never displaces the path, because the path is found by its shape,
    not by its position.
  - **Everything else naming another repository is a write.** The gate
    calls `checkContact` with `github:<owner>` of the first other
    repository referenced and, when refused, the shim exits 1 with the text
    and makes no call. A form the gate cannot place as a read is a write:
    the gate never allows a call to another repository because it did not
    recognise it. A refused call is recorded in the action log (`agent:
    <stage or agent>`, `kind: contact_refused`, `status: refused`, the party
    and the command as its group, verb, method and repository, never a body
    or a header value) so the action audit and the console can see
    attempts. The parameter is read from the store at each call; the system
    cannot change it (spec 008 AC-12).

  The tests run the shim itself (`bin/gh` under `sh`, with a recording fake
  `gh` after it on `PATH` and the scheduler's `contacts gate` behind
  `PANELATOR_SCHEDULER`), not only `classifyGh`, and cover at least:
  refused, with one `contact_refused` row and no call reaching the fake:
  `gh issue create -R other/repo -t x -b y`, the same with `-Rother/repo`
  and `--repo=other/repo`, `gh pr comment https://github.com/other/repo/pull/5 --body x`,
  `gh issue comment https://github.com/other/repo/issues/1 --body x`,
  `gh pr review https://github.com/other/repo/pull/5 --approve`,
  `gh api -X POST repos/other/repo/issues -f title=x`, the same with
  `-XPOST`, `gh api -H "Accept: application/vnd.github+json" -X POST repos/other/repo/issues -f title=x`,
  `gh api --jq .number -X POST repos/other/repo/issues -f title=x`,
  `gh api repos/other/repo/issues -f title=x` (a body and no method),
  `gh api -ftitle=x repos/other/repo/issues`, `gh api https://api.github.com/repos/other/repo/issues -X POST`,
  `gh repo fork other/repo`; allowed, reaching the fake unchanged, with no
  row: `gh api -X POST repos/{owner}/{repo}/issues/39/comments -f body=x`,
  the same with `:owner/:repo` and with the configured repository spelled
  out in another case, `gh issue create -R <configured repo> -t x -b y`,
  `gh pr comment https://github.com/<configured repo>/pull/5 --body x`,
  `gh issue view -R other/repo 1`, `gh api repos/other/repo/issues`,
  `gh api -H "Accept: application/vnd.github+json" repos/other/repo`,
  `gh pr view https://github.com/other/repo/pull/5`, `gh repo clone other/repo`,
  `gh api /app`, `gh pr list`, `gh auth status`; and `gh issue create -R
  other/repo` going through after an approval of AC-8. A new form found
  later is added to this list in the implementing PR, not argued over.
- AC-12. **Approved parties are visible and only the maintainer removes
  them.** `panelator-scheduler contacts list` prints the parties with their
  approval time, issue and question id; `contacts remove <party>` deletes an
  entry and is logged as `maintainer`. No action kind writes
  `contacts/parties.json`; a test asserts it.

**Credential check agent** (design section 6.1)

- AC-13. **The credential check is a standing agent.**
  `agents/standing/credential-check.md`: standard tier, Claude, `worktree:
  none`, schedule `1d`, events `credential_expiry`, credentials none,
  actions `renew_credential`, output `credential-check-result`. That schema,
  `schemas/scheduler/credential-check-result.json`, extends
  `standing-result.json` through `allOf` and adds the optional `warnings`
  field below, the way `filer-result.json` extends it; the registry accepts
  no other shape for a custom output, and the scheduler validates the result
  against the schema the frontmatter names, so `output: standing-result`
  would reject `warnings` *(agent's call, answering the plan stage)*. The
  scheduler applies `warnings` in `src/standing/run.ts` after the result is
  validated, as it applies a `filer-result`. Its input is the
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
  `infra_alarm` and `ci_failure_main`, credentials none, actions
  `rerun_workflow`, `run_agent`, `pause_agent`, output `standing-result`.
  It ships now with what `main` produces *(agent's call, answering the plan
  stage; section 4)*: its input is the pending events with their payloads
  (spec 015 AC-8's outage alarm, whose payload has no `kind`, and the
  `ci_failure_main` of spec 008 AC-4; a payload with a `kind` it does not
  know, such as spec 022 AC-9's `aws_forecast_over_cap` once that exists, is
  reported in the summary and filed as one finding, not acted on), the
  standing agents' state files (consecutive failures, paused, by the
  maintainer or not), the last 24 hours of the service log's tick summaries,
  and the action log of the last 7 days. The sweep reads only. Its prompt
  sets the limits: it may re-run a failed `main` workflow once per run id
  (the kind's own bound), pause a standing agent with three consecutive
  failures that the maintainer has not paused or resumed since, mark an
  agent due with `run_agent` when an alarm names it, and must file a finding
  (not act) for an outage past the `infra` alarm, a `main` failure that a
  re-run did not clear, or anything needing a reviewed PR, funds, a
  credential or a first contact. Given nothing is wrong, then the summary
  says so and no action is requested. The follow-up spec adds the AWS half
  (section 2) by extending this definition and prompt, not replacing them.
- AC-16. **No AWS action here.** The `aws_scale` kind, the `scale` descriptor
  on a reservation and the ledger input are the follow-up spec's (section 2)
  *(agent's call)*; this spec adds no `aws` action, spawns no `aws`, and
  leaves `agents/actions.yaml` with `renew_credential` as its one new kind.
  The number is kept so that the follow-up's criterion and the plan stage's
  references to it do not move.
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
- **The gate reads tokens and fails closed** *(agent's call, 2026-11-05)*.
  The first version of AC-11 listed the `gh` forms to refuse, and the
  implementation parsed them by position. Three review rounds each found a
  form that slipped past (`{owner}/{repo}` placeholders refused; URL
  selectors, `-Rother/repo` and `-XPOST` allowed; a header before the API
  path displacing it), and each fix invited the next. The list was the
  flaw: gh has more spellings than a spec can enumerate, and a positional
  parser is wrong whenever gh accepts a flag the parser does not know. The
  rule now is the inverse: find every repository reference by its shape in
  any token, allow a call that names only the configured repository, allow
  a known read of another repository, and treat every other call naming
  another repository as a write. An unknown form is then refused rather
  than allowed, which costs a stage one retry with a known spelling and
  never costs an unapproved contact. The shell side keeps one test, "does
  any argument contain a `/`", because every repository reference does; it
  decides nothing else. The choice is not an ADR: the gate is one function
  and the test list in AC-11 is where a new spelling goes.
- **The request check judges nothing from the question's words** *(agent's
  call, 2026-11-05)*. A word list in the scheduler for "this question is a
  credential need" misread "physical access to the test board" as a
  credential request and sent a question only the maintainer could answer
  back to the stage. Whether a request-less capability question is one of
  the three needs is a judgement, and the question check is the stage that
  already makes judgements about questions; the scheduler keeps only the
  check it can make exactly, that a request the stage did write is
  complete.
- **Alerts are one-way.** Spec 007 made questions a conversation; a `funds`
  refusal or a cap alert needs nothing back through the system (the
  maintainer acts with the command line or the console), so the
  `TelegramNotifier` is a sink and a reply to it is told so.
- **Infra health scales only what was described at launch.** The design's
  "within limits that already exist" and spec 022's ledger meet in the
  `scale` descriptor: the launcher that stated a cost also states how to
  make it smaller, and the agent can only ever move between the two states
  the launcher wrote down. That is the follow-up spec's to build (section
  2); the limit is stated here so the agent's prompt is written against it
  from the start.
- **Why this spec is split, and why infra health ships now** *(agent's
  call, 2026-11-04, answering the plan stage)*. The spec was written against
  specs 022 and 026 as if they were code. On `main` there is no
  `tools/scheduler/src/aws/`, no `src/events/`, no `maintainer.contact`
  event and no fake `aws`; spec 026's issue (#93) is unclaimed and spec
  022's (#37) is labelled `blocked` on it, so the wait would be two
  implementation chains long. The design's table order (section 11, F1
  before F2) is the author's call, and the dependency runs one way only: the
  credential store, the wrappers, the request object, the first-contact
  gate, the Telegram notifier and the credential check need nothing from
  AWS or the event store, while the AWS half and the events need both.
  Waiting was the other option; it was ruled out because the plan stage can
  return only `ready` or `spec_gap`, the spec stage cannot label an issue,
  and a status line does not stop the shortlist (which skips only labels),
  so "wait" would have meant another spec-gap round each time #39 was
  claimed. The cut follows spec 029's row E split: the second part is its
  own spec and issue, derived from this spec, spec 022 and spec 026, with
  this spec's section 2 as the map of what it carries (as ADR 0004 mapped
  spec 012's criteria). The spec stage may not file issues, so the result
  of this revision carries a finding asking the findings filer to file the
  follow-up issue, depending on #37 and #93; issue #126 records that the
  filer cannot yet label it `blocked`, so the filer decides when to file it.
  Infra health ships now rather than whole in the follow-up because its
  GitHub-side half (the outage alarm of spec 015, `ci_failure_main`,
  re-runs, pausing a failing agent, the restart finding of AC-17) is
  buildable and useful today, is the "watcher of the host" that issue #124
  asks to have sooner, and loses nothing by gaining its AWS half later: a
  standing agent's definition and prompt are extended in place, and an alarm
  payload it does not know is filed, not acted on (AC-15).

## 5. Interfaces and files

- `tools/scheduler/src/credentials/`: `catalogue.ts` (`agents/credentials.yaml`,
  its checks, AC-2), `store.ts` (`readSecret`, `writeSecret`, `index.json`,
  the `systemd-creds` spawn with the command path injectable, AC-1),
  `shims.ts` (the per-run shim directory, AC-3), `check.ts` (checks, probes,
  the `credential_expiry` producer, AC-4, AC-5), `commands.ts` (`cred set`,
  `list`, `check`, `import`, `remove`, `exec`, AC-3, AC-4).
- `tools/scheduler/src/contacts/`: `gate.ts` (`checkContact`, `classifyGh`,
  `contacts/parties.json`, AC-11), `commands.ts` (AC-12), `approve.ts` (the
  answer handling of AC-8).
- `tools/scheduler/src/notify/telegram.ts`: `TelegramNotifier` (AC-9);
  `src/notify/log.ts` and `src/notify/types.ts`: `channel` on the log line
  (AC-9); `src/telegram/questions.ts`: request rendering and the fixed
  keyboards (AC-7), the alert-reply response (AC-10); `src/telegram/answers.ts`:
  the outcome of AC-8; `src/telegram/poller.ts`: alert message ids kept so
  replies to them are recognised; `src/telegram/credentials.ts` and
  `src/service/telegram-start.ts`: the bot token read from the store once
  `telegram-bot` is set, else from `telegram.credentials_path` (AC-3, AC-4).
- `tools/scheduler/src/chain/driver.ts`, `src/chain/question.ts` and
  `src/chain/machine.ts`: the request in the comment (AC-7), the pre-resume
  step of AC-8, the completeness check before the question check (AC-6);
  `src/decide/request.ts` (the completeness check and its reason, AC-6)
  and `src/decide/client.ts` (the request in the question check's input).
- `tools/scheduler/src/actions/`: `renew-credential.ts` (AC-14), `index.ts`
  (the kind registered), `contact-refused` log entries (AC-11);
  `agents/actions.yaml` gains `renew_credential` (AC-16: nothing for AWS).
- `tools/scheduler/src/runner/credentials.ts` and `src/runner/run.ts`: the
  shim directory first on `PATH`, `PANELATOR_SCHEDULER` in the environment,
  the App key from the store (AC-3, AC-11); `src/standing/run.ts` and
  `src/standing/registry.ts`: credentials for standing agents, the
  `warnings` of a `credential-check-result` applied as notifications
  (AC-13), the `cred check` run before the credential check's input is
  built; `src/standing/credential-check-input.ts` and
  `src/standing/infra-health-input.ts`: the two agents' inputs (AC-13,
  AC-15), as `audit-input.ts` builds the audit's.
- `tools/scheduler/src/profiles/resolve.ts`, `src/stages/definition.ts`,
  `src/types.ts`: `credentials` replaces `credential_hook` (AC-2); the
  `Request` type and `request` on `Question` (AC-6).
- `tools/scheduler/src/service/loop.ts` and `bin/scheduler.ts`: the hourly
  expiry step, the `TelegramNotifier` wiring in the order AC-9 fixes, the
  `channel` on the notification's log line (AC-5, AC-9).
- `tools/scheduler/src/config.ts` and `agents/scheduler.yaml`: the
  `credentials` block (AC-1).
- `tools/scheduler/src/state/paths.ts`: `contacts/parties.json`.
- `tools/scheduler/src/state/questions.ts` and
  `schemas/scheduler/question-log-entry.json`: `request` on the entry and
  `outcome` on its answer record (AC-7, AC-8). No event store file: spec
  026's `maintainer.contact` additions are the follow-up spec's.
- `tools/scheduler/src/schema/validate.ts`: the new schemas registered.
- `tools/scheduler/bin/gh`: the gate (AC-11); `bin/scheduler.ts`: the
  `cred`, `contacts` and `contacts gate` commands.
- `agents/credentials.yaml` (AC-2); the four profiles
  `agents/profiles/backend/profile.yaml`, `agents/profiles/design/profile.yaml`,
  `agents/profiles/security/profile.yaml` and `agents/profiles/spec/profile.yaml`:
  `credentials` in place of `credential_hook`; `agents/standing/credential-check.md`
  and `agents/standing/infra-health.md` (AC-13, AC-15);
  `agents/stages/question-check.md`: the request requirement (AC-6);
  `agents/stages/plan.md`, `implement.md`, `fix.md`, `review.md`, `spec.md`:
  one paragraph on the `request` object a credential, funds or first-contact
  question must carry, and that a refused `gh` call means "ask first".
- `schemas/scheduler/`: `credential-catalogue.json`, `credential-index.json`,
  `contacts.json`, `credential-check-result.json`,
  `credential-check-input.json`, `infra-health-input.json`, `question.json`
  (the `request` object, shared by every stage's result schema and the
  paused record), `standing-definition.json` and `profile.json`
  (`credentials`), `action.json` (`renew_credential`).
- `tools/scheduler/test/`: `credentials.test.ts` (store, catalogue checks,
  shims, commands, expiry producer, secrets never logged, AC-1 to AC-5),
  `contacts.test.ts` (the shim run under `sh` with the forms of AC-11,
  `classifyGh`, approval, commands, AC-8, AC-11, AC-12), `notify.test.ts`
  (the Telegram notifier, alert replies, AC-9, AC-10), `request.test.ts`,
  `decide.test.ts` and `driver.test.ts` (AC-6 to AC-8), `actions.test.ts`
  (`renew_credential`, AC-14), `telegram.test.ts` (rendering, keyboards,
  the alert reply), `standing.test.ts` and the registry test over the two
  new agents, `profiles.test.ts` and `schema.test.ts` (`credentials`, the
  new schemas), `loop.test.ts` (the hourly step, the notifier wiring), and
  the recorded runs of section 6 in `e2e.test.ts` with
  `test/helpers/e2e-routes.ts`; the fake `systemd-creds` and the recording
  fake `gh` under `test/helpers/`.
- `tools/README.md`: the `cred` and `contacts` commands, the `credentials`
  block, the catalogue (documentation of the tool, in its own package).

This list is the implementation's file scope. The plan stage copies it, and
may add a file under `tools/scheduler/`, `agents/` or `schemas/scheduler/`
that the build turns out to need, naming it in the plan; the scope check of
the implement stage compares the diff with the plan, so a file is added to
the plan, not left for the diff to reveal. No file outside `tools/scheduler/`,
`agents/`, `schemas/scheduler/` and `dev-logs/` is changed by the
implementation except `tools/README.md`.
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
    fake `systemd-creds`; no `aws`) for: a credential question with a
    complete request sent with "Done"/"Can't" buttons, "Done" pressed, the
    check passing, the stage resumed with `done (verified)`, merged; the
    same with the check failing and a follow-up; a credential question
    without `setup` sent back by the check as `decide_yourself`; a
    first-contact question approved by button, the party registered, a `gh
    issue create -R other/repo` from the resumed stage going through, and
    the same call refused before approval with one `contact_refused` log
    entry; the shim-level table of AC-11 (every refused form with one log
    row and no call, every allowed form reaching the fake `gh` unchanged),
    run through `bin/gh` itself; a capability question with no `request`
    about physical access to the test board reaching the question check
    untouched by the scheduler (AC-6); an `infra` notification (spec 015 AC-8's outage) delivered to the
    chat headed by its gate and label and logged with `channel: telegram`,
    and the same with the fake Telegram refusing, logged once with `channel:
    log`; a reply to an alert answered "alerts take no reply"; the
    credential check woken by `credential_expiry` for a test catalogue entry
    with `expiry: index` three days from expiry, one `credential-expiry`
    notification with its setup steps, nothing twice that day; infra health
    woken by `ci_failure_main`, re-running the failed `main` workflow once;
    infra health pausing a standing agent with three consecutive failures
    and filing a finding for an `infra_alarm` payload whose `kind` it does
    not know; every earlier recorded chain (specs 006, 007, 008, 011, 013,
    015, 020, 025, 029) unchanged with no `credentials` block and Telegram
    off.
- On the laptop, after `cred import` and `cred set` for the two existing
  secrets, `panelator-scheduler cred check` exits 0 for both catalogue
  entries and `telegram-check` still passes; the implement stage runs them
  and quotes the output in the PR. Importing is the maintainer's step (the
  files are theirs); the implement stage raises it as a capability question
  with the `cred import` command and the two files to delete when it reaches
  this step and the index is empty.
- After the service is restarted on the merged code, the first real
  Telegram alert, the first credential check run and the first infra health
  run are written up in `dev-logs/` with their run records and the service
  log lines that carry `channel`.

## 7. Open decisions

None.
