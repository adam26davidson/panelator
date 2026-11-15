# 068. Row F2, second part: the `aws-sso` credential, `maintainer.contact` events for requests and notifications, the funds request over Telegram, and infra health's AWS half

Status: written 2026-11-15 from the delivery-system design (row F2, second
part) for issue #130; specs derived from that design need no maintainer
approval (design section 11). This is the follow-up spec that
[030-beyond-github](../030-beyond-github/spec.md) section 2 ("Everything that
needs spec 022 or spec 026 on `main`") and section 4 ("Why this spec is
split") map out; it carries exactly that list. It amends, each marked as
section 4 records: spec 030 AC-2 (the `aws-sso` entry), AC-7 and AC-8 (the
`maintainer.contact` events for a request's send and answer), AC-9 (the
recorder's place and the notifier's reported channel) and AC-16 (`aws_scale`
exists); [022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-6
(the optional `scale` descriptor on a reservation) and AC-7 (the funds
notification's layout and its one event);
[026-event-store](../026-event-store/spec.md) AC-2 (the `maintainer.contact`
payload gains `request`, `outcome` and the `telegram` channel); and
[064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-5 (the infra health definition, input and prompt gain their AWS half).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("AWS for the delivery system": the system "forecasts the month's
spend daily and acts early ... shrinking or stopping what it does not need, or
asking for budget days ahead"; "Credentials"; "Funds": requested on Telegram
with what for, the amount and the charter goal; "Telegram carries ...
credential and fund requests"), section 6.1 (infra health: alarms plus a
sweep, direct actions and findings; credential check: early Telegram warnings),
section 6.2 (level 1: "scale resources within the AWS cap"; every direct
action recorded with its undo; the cap cannot be changed by the system),
section 7 (everything recorded raw), section 11 (row F2; "F is split so that
the AWS account and cap enforcement exist before" what uses them);
[charter](../../docs/charter.md) (the strictly enforced AWS cap; funds may be
requested); [030-beyond-github](../030-beyond-github/spec.md) sections 1, 2
and 4, AC-2 (the catalogue and the `provider: aws` rule), AC-3 (shims), AC-5
(the `credential_expiry` producer), AC-6 and AC-7 (the request object and how
it is rendered), AC-8 (the outcomes), AC-9 (the `TelegramNotifier` and the
wiring order), AC-13 (the credential check), AC-16;
[022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-1 and AC-2
(the profile, `src/aws/cli.ts`, the identity check), AC-3 (the SSO expiry
read from `~/.aws/sso/cache/`), AC-5 (the forecast), AC-6 (the ledger), AC-7
(the funds refusal), AC-9 (the `aws_forecast_over_cap` alarm), section 8
(the SSO session and the policy); [026-event-store](../026-event-store/spec.md)
AC-1 and AC-2 (`recordEvent`, the `maintainer.contact` payload and the kinds
`funds`, `credential`, `first_contact` it reserved) and section 5 (the
recording wrapper); [050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md)
AC-3 (every alarm carries a `kind`) and AC-4 (the policy's two actions);
[064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-5 (the infra health definition this spec extends);
[008-agent-registry](../008-agent-registry/spec.md) AC-5, AC-8 and AC-9
(results, action kinds, the action log); [ADR 0005](../../docs/decisions/0005-console-static-site-serverless-api.md)
(the console's Lambda, CloudFront and DynamoDB, the kinds `aws_scale` moves);
[051-console](../051-console/spec.md) AC-7 (the first launcher, which calls
`reserveSpend`).

What the maintainer decided (design sections 6.2 and 8), kept as it is here:
the system shrinks or stops what it does not need when the forecast is over
the cap and asks for budget days ahead; scaling stays within the cap and
within limits that already exist, and the cap itself is never changed by the
system; funds are requested over Telegram with what for, the amount and the
charter goal; credentials are used through wrappers and the credential check
warns early; everything is recorded raw.

## 1. Goal

Finish row F2 with the four pieces spec 030 set aside until specs 022 and 026
were on `main`:

- **The AWS session is a credential like the others.** `agents/credentials.yaml`
  gains `aws-sso`, so the credential check probes the SSO session's expiry
  from the CLI's own cache, warns the maintainer over Telegram with the login
  steps before the session ends, and judges the pipeline's AWS access against
  the catalogue. Every `aws` spawn keeps going through `src/aws/cli.ts`.
- **Every contact with the maintainer is an event.** A credential, funds or
  first-contact request leaves one `maintainer.contact` event when it is sent
  and one when it is answered, with the request and the outcome in the
  payload; every notification's event says whether Telegram or the log
  carried it. The recorder sits where spec 030 AC-9 left room for it, so a
  notification the rate limiter suppressed is not a contact.
- **A refused launch is a funds request the maintainer can read.** The
  `aws-funds` notification of spec 022 AC-7 is laid out as a `funds` request
  (amount, purpose, charter goal) in the form spec 030 AC-7 renders one, with
  the two steps that raise the cap, and is recorded once as `kind: funds`.
- **Infra health can shrink what the ledger lets it shrink.** A reservation
  may carry a `scale` descriptor written by its launcher, the two states the
  launcher wrote down; the level-1 action `aws_scale` moves a reservation
  between them through `src/aws/cli.ts`, and infra health, woken by spec 022
  AC-9's `aws_forecast_over_cap` alarm with the ledger and `cost.json` in its
  input, scales down until the forecast is under the cap and back up when it
  is, filing a finding for what it cannot scale or cannot explain.

**What `main` must have before this is built.** The implementation needs the
implementations of spec 022 (issue #37: `tools/scheduler/src/aws/`, the fake
`aws` under `test/helpers/`, `aws/ledger.json`, `aws/cost.json`) and of spec
030 (`tools/scheduler/src/credentials/`, `agents/credentials.yaml`,
`src/notify/telegram.ts`, the request rendering of AC-7 and the pre-resume
step of AC-8) merged. Spec 026 is on `main` (issue #93 closed:
`src/events/`, `schemas/scheduler/event.json`, `src/notify/recorded.ts`),
as is spec 064 (`agents/standing/infra-health.md`, `sweep_volume`). Until
spec 022's and spec 030's implementations are on `main`, the plan stage
finds those paths missing and does not start this build; the issue should
carry `blocked` (spec 066) until then. Nothing here is written so that it has
to change if either of those lands in a later revision than its spec: the
interfaces this spec builds on are the ones their specs fix by name.

## 2. Out of scope

- Everything spec 030 builds (the store, the shims, the request object, the
  gate, the `TelegramNotifier`, the two standing agents' GitHub-side halves)
  and everything spec 022 builds (the account, the pull, the forecast, the
  ledger's `reserveSpend` and `releaseSpend`, the thresholds, the alarm, the
  commands). This spec adds to them and changes none of their rules.
- Launching anything in AWS. The `scale` descriptor is written by a launcher;
  the only launcher specified is spec 051's console deploy (its AC-7), and
  whether it passes descriptors for its Lambda functions, distribution and
  table is spec 051's to add (a finding of this spec's run asks for it). Here
  the descriptor's shape, the ledger's handling of it and the action that
  reads it are built and tested against fixture reservations.
- A button that raises the cap, or any path by which the system changes
  `aws_cap_usd` or the AWS budget (spec 030 section 2; design section 6.2).
  The funds message names the maintainer's two steps.
- Scaling kinds beyond the three ADR 0005's console will launch
  (`lambda-concurrency`, `cloudfront-distribution`, `dynamodb-throughput`).
  A later launcher that reserves another kind of resource adds its kind to
  `aws_scale` in its own spec, with the `aws` calls and the policy actions.
- Operating the product's AWS account (design section 8 allows it "within
  the product's rules"; no product resource is launched by the delivery
  system yet, so nothing here reads or writes that account).
- A second AWS credential (an access key, option B of spec 022 section 8).
  The catalogue entry is for the SSO session the maintainer chose to set up;
  an access key would be a second entry with `expiry: none`, added when it
  exists.
- Intake, grilling, group chats, a second maintainer (spec 007 section 2).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review; changing the lock rule or
  the `maintainer` actor set of spec 008 AC-12; changing design section 3.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API, the fake Telegram
server of spec 007, the fake `systemd-creds` of spec 030 section 3, and the
fake `aws` command of spec 022 section 6 extended with fixture answers for the
calls of AC-8, plus a fixture home directory holding `.aws/config` and
`.aws/sso/cache/` (the scheduler reads the AWS CLI's home from `HOME`, or from
`AWS_CONFIG_FILE` and `AWS_SSO_CACHE_DIR` when set, so tests point at
fixtures). "AWS on", *cap*, *actual*, *reserved* and *forecast* are spec 022
AC-3's definitions; "Telegram on" is spec 007's; *store directory* and
*catalogue* are spec 030 AC-1's and AC-2's; *recorder* is spec 026's
`recordedNotifier`.

**The `aws-sso` credential** (design section 8, "Credentials"; spec 030
section 2, first bullet)

- AC-1. **The catalogue knows the SSO session.** `agents/credentials.yaml`
  gains the entry `aws-sso`: `provider: aws`; `purpose` "the AWS CLI SSO
  session of the delivery-system account (spec 022 section 8)"; `access` the
  policy actions the pipeline's permission set grants, as a list: the two of
  spec 050 AC-4 (`sts:GetCallerIdentity`, `ce:GetCostAndUsage`) and the six
  of AC-9 below; `used_by: [infra-health]` (the scheduler's own identity
  checks, pulls and `aws_scale` applications use the profile directly through
  `src/aws/cli.ts`, spec 022 AC-1, and are not a profile or agent the field
  can name); `wrapper: { command: aws, env: AWS_PROFILE }`, the secret being
  the profile name of the `aws` block (`cred set aws-sso` reads it from
  stdin like any secret, so the store, the index and the shim rules of spec
  030 AC-1 to AC-4 apply unchanged, and `used_by` has something to wrap);
  `expiry: { probe: "panelator-scheduler aws sso-expiry" }` (AC-2); `check:
  "aws sts get-caller-identity"`; `renew: manual`; `setup` the numbered steps
  of spec 022 section 8, step 2, option A, as they stand after spec 050 AC-4
  (the permission set, the `~/.aws/config` stanza, `aws sso login
  --sso-session default`, `aws sts get-caller-identity --profile
  panelator-delivery`), then `panelator-scheduler cred set aws-sso` with the
  profile name, then `panelator-scheduler aws-check`.

  The rule of spec 030 AC-2 for `provider: aws` holds: the `check` and a
  `cred exec aws-sso -- <args>` are run by `src/aws/cli.ts` with `--profile
  <the secret>`, `--region`, `--output json` and its timeout, never by `cred
  exec`'s own spawn, so spec 022 AC-6's grep for `aws` invocations outside
  `src/aws/` keeps passing. Given the `check` runs, then it passes only when
  the returned account is the configured `account_id` (spec 022 AC-2's
  test, reused), so a profile for another account is a failed check, not a
  working credential. The probe spawns no `aws` at all (AC-2), which is the
  one refinement of that rule, and the grep is unaffected. Given no `aws`
  block in `agents/scheduler.yaml`, then the entry still loads (the catalogue
  is repository content), `cred list` shows it missing, its check fails with
  "aws: off" and nothing calls `aws`; the recorded chains of earlier specs
  run unchanged.
- AC-2. **The expiry comes from the CLI's cache, and the token is never
  read.** `panelator-scheduler aws sso-expiry [--profile <name>]` (default:
  `AWS_PROFILE`, else the `aws` block's `profile`) prints the session's
  `expiresAt` as ISO time, or the word `none` when the profile is not an SSO
  profile, or exits 1 with a reason when the profile or its cache file is
  missing. It reads the profile stanza from `~/.aws/config`: with
  `sso_session = <name>`, the cache file is `~/.aws/sso/cache/<sha1 hex of
  the session name>.json`; with the legacy `sso_start_url`, `<sha1 hex of
  the start URL>.json` (how the AWS CLI names them). Of that file only
  `expiresAt` is read; `accessToken`, `clientSecret` and every other field
  are never read into a variable, logged, printed or recorded, asserted by a
  test over the service log, the command's output and the index after a
  probe. The same function (`ssoExpiry(profile, env)` in
  `tools/scheduler/src/aws/sso.ts`) serves `aws-check`'s expiry line of spec
  022 AC-3, so there is one reader. Given the credential check's daily run or
  a `credential_expiry` event (spec 030 AC-5, produced from the probe's
  `expires_at` in the index), then the credential check (spec 030 AC-13)
  carries `aws-sso` in its `warnings` when the session ends within
  `warn_days` or the last check failed, and the scheduler sends one
  `credential-expiry` notification with the entry's `setup` steps (the login
  step first), once per day, over Telegram when it is on (spec 030 AC-9).
  Spec 022 AC-2's `aws-access` notification on an identity failure is
  unchanged and separate: it says AWS went off, the warning says how to log
  in again.

**Events for every contact** (design section 7; spec 026 AC-2; spec 030
section 2, second bullet)

- AC-3. **A request's send and answer are one event each.** Given a question
  carrying a `request` (spec 030 AC-6) is sent (spec 007 AC-5, spec 030
  AC-7), then the `maintainer.contact` event spec 026 AC-2 records for the
  `sent` entry has `kind` equal to `request.type` (`credential`, `funds` or
  `first_contact`) instead of `question`, `label: "request"`, `text` the
  rendered message, and `payload.request` the request object as sent; one
  event, not one for `question` and one for the type. Reminders stay `kind:
  reminder`. Given the answer (spec 030 AC-8, after the scheduler's own step
  and before the stage resumes), then one `maintainer.contact` event is
  recorded with the same `kind`, `channel` that of the answer (`telegram`
  for a button or a chat message, `issue` for a comment), `label: "answer"`,
  `text` the answer as the stage receives it (`done (verified)`, `done
  (check failed: <reason>)`, the button's word or the text), `payload.request`
  and `payload.outcome` one of `approved`, `denied`, `declined`, `verified`,
  `check_failed`, `text` (spec 030 AC-8's outcomes), with `issue` and
  `question_comment_id` set on both events. The question log entry of spec
  030 AC-7 and AC-8 is unchanged; the event is recorded beside it, by
  `src/state/questions.ts` for the send (where spec 026 section 5 put the
  `sent` contact) and by the pre-resume step of AC-8 for the answer.
- AC-4. **A notification's event names the channel that carried it.**
  `Notifier.notify` resolves to `{ channel: "telegram" | "log" }`: the
  `LogNotifier` returns `log`; the `TelegramNotifier` of spec 030 AC-9
  returns `telegram` after a successful send and `log` when Telegram is off
  or the send failed (the log line stands either way, as that criterion
  says); the rate limiter returns the inner's value when it sends and
  `{ channel: "suppressed" }` when it does not. The wiring in
  `tools/scheduler/bin/scheduler.ts` is
  `rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`, the
  recorder between the rate limiter and the `TelegramNotifier` as spec 030
  AC-9 fixed it, so the recorder records `channel` from the inner's return
  and a suppressed notification is not a contact. The service log line's
  `channel` of spec 030 AC-9 and the event's `channel` are the same value
  from the same return. A notification may carry an optional `contact: {
  kind, request }` (AC-6): given it, the recorder writes `kind: contact.kind`
  and `payload.request: contact.request` instead of `kind: notification`,
  so a notification that is a request is recorded once, as the request.
  `schemas/scheduler/event.json`'s `maintainer.contact` payload gains the
  optional properties `request` (an object with `type` in the three-value
  enum, otherwise the shape spec 067 AC-1 gives `question.json`) and
  `outcome` (the six values of AC-3); `channel` stays a string. No kind is
  added to `tools/scheduler/src/events/kinds.ts`. Tests: a `funds`
  notification sent with Telegram on leaves one event `{ channel: telegram,
  kind: funds, request }`; the same with the fake Telegram refusing leaves
  `{ channel: log, kind: funds }`; a second notification of the same label
  within the rate limit leaves no event; a notification without `contact`
  leaves `kind: notification` as today.

**The funds request over Telegram** (design section 8, "Funds"; spec 022
AC-7; spec 030 section 2, third bullet)

- AC-5. **A refused reservation reads as a funds request.** Given a refused
  reservation (spec 022 AC-6), then the `aws-funds` notification's `text` is
  the labelled list spec 030 AC-7 renders for a `funds` request, built from
  the refusal: `Amount: <shortfall_usd> USD a month` (the shortfall against
  the cap, rounded up to the cent); `Purpose: <what> (expected
  <expected_monthly_usd> USD a month)`; `Charter goal: <why>` (spec 022 AC-6
  requires `why` to name it); then the lines `Forecast: <forecast_usd> USD
  against a cap of <cap_usd> USD (reserved <reserved_usd> USD)` and `Asked
  by: <by>`; then, in place of buttons, the maintainer's two steps that raise
  the cap: `panelator-scheduler param set aws_cap_usd <cap + shortfall>` and
  the budget amount in the management account (spec 022 section 8, step 3),
  and the line that the launch is retried by whoever asked once the cap
  allows it (spending the funds is the maintainer's action, spec 030 AC-8).
  The notification carries `contact: { kind: "funds", request: { type:
  "funds", amount_usd: <shortfall_usd>, purpose, charter_goal: <why> } }`,
  so the recorder (AC-4) writes the one `maintainer.contact` event with
  `kind: funds` that spec 022 AC-7 asks for, with `channel` the one that
  carried it; `src/aws/ledger.ts` records no contact event itself. The
  notification is headed by its gate and label (spec 030 AC-9), has no
  buttons, and the rate limit of spec 022 AC-7 (the same `what` not notified
  again within `notify_rate_limit_hours`) is unchanged. Given a cap of 0,
  then the text's steps say the cap is 0 and name the amount that would
  admit the reservation (the whole expected cost). The other AWS labels
  (`aws-access`, `aws-cap-80`, `aws-cap-hit`, `aws-forecast`) need nothing:
  spec 030 AC-9 forwards every label with the notification's own text.

**Infra health's AWS half** (design sections 6.1, 6.2 and 8; spec 022 AC-6
and AC-9; spec 030 section 2, fourth bullet; spec 064 AC-5)

- AC-6. **A reservation may say how it gets smaller.** `reserveSpend`'s input
  and the reservation record of spec 022 AC-6 gain an optional `scale: {
  kind, id, up, down }`: `kind` one of `lambda-concurrency`,
  `cloudfront-distribution`, `dynamodb-throughput`; `id` the resource the
  launcher created (the function name, the distribution id, the table name);
  `up` and `down` each `{ expected_monthly_usd, setting }`, where
  `expected_monthly_usd` is the cost in that state (`up`'s equal to the
  reservation's own, `down`'s lower) and `setting` is the kind's: for
  `lambda-concurrency` `{ reserved_concurrency: <integer ≥ 0> }`; for
  `cloudfront-distribution` `{ enabled: <boolean> }`; for
  `dynamodb-throughput` `{ billing_mode: "PAY_PER_REQUEST" }` or `{
  billing_mode: "PROVISIONED", read_capacity_units, write_capacity_units }`.
  A descriptor failing this shape, or `down.expected_monthly_usd` not below
  `up.expected_monthly_usd`, fails the reservation with `{ ok: false, reason
  }` before anything is written. A reservation with a descriptor carries
  `scale.state`, `up` when written. While `scale.state` is `down`, the
  reservation's `expected_monthly_usd` is `down.expected_monthly_usd`, and
  `reserved_usd` and the forecast's ledger view (spec 022 AC-5) use that;
  the launcher's figure stays in `scale.up`. `schemas/scheduler/aws-ledger.json`
  gains the field. The open reservations printed by `panelator-scheduler
  aws` (spec 022 AC-10) show `scale.kind` and `scale.state` when present.
  Given a reservation without `scale`, then nothing about it changes.
- AC-7. **`aws_scale` is a level-1 action.** `agents/actions.yaml` gains
  `aws_scale` (level 1, "Move a ledger reservation between the two states
  its launcher described, within the AWS cap"), with
  `tools/scheduler/src/actions/aws-scale.ts` in `KINDS` so
  `registryActionsCheck` passes. Its `check` requires `exact(args,
  ["reservation_id", "direction"])` and refuses, with the reason: a
  `reservation_id` not in `aws/ledger.json`; a released reservation; one
  without a `scale` descriptor; a `direction` other than `up` or `down`; a
  direction equal to `scale.state` ("already <direction>"); AWS off (spec
  022 AC-2); and `direction: up` when the forecast recomputed with
  `up.expected_monthly_usd` (spec 022 AC-5) would be above a non-zero cap
  ("scaling up would put the forecast over the cap"), so the action can
  never undo what the alarm asked for. Its `apply` runs the kind's call
  through `src/aws/cli.ts` with the target state's `setting`: `lambda
  put-function-concurrency --function-name <id>
  --reserved-concurrent-executions <n>`; `cloudfront get-distribution-config
  --id <id>` then `cloudfront update-distribution --id <id> --if-match
  <ETag> --distribution-config <the config with Enabled set>`; `dynamodb
  update-table --table-name <id>` with `--billing-mode` and, when
  provisioned, `--provisioned-throughput`. Given the call succeeds, then the
  reservation's `scale.state` and `expected_monthly_usd` are rewritten,
  `reserved_usd` and `forecast_usd` are recomputed and spec 022 AC-9's state
  re-evaluated (the recovery notification when the forecast falls under the
  cap), one `aws.reserve` event is recorded with `outcome: "scaled"` and
  `direction`, and the action's `undo` is `{ kind: "aws_scale", args: {
  reservation_id, direction: <the opposite> } }`. Given the call fails or
  times out, then the ledger is unchanged and the action is `failed` with
  the `aws` error's first line (no secret, spec 022 AC-1). The `aws` calls
  this adds are the only ones outside spec 022's, all in `src/aws/scale.ts`,
  so spec 022 AC-6's grep still passes; spec 022 AC-11's assertion (no
  `setParameter` under `src/aws/`) still passes. Only infra health's
  `actions` list and the maintainer's `panelator-scheduler action undo`
  reach the kind.
- AC-8. **Infra health gets the ledger and the alarm.**
  `agents/standing/infra-health.md` (spec 064 AC-5) gains `credentials:
  [aws-sso]` (spec 030 AC-2's optional key; the shim exists per spec 030
  AC-3, and the agent, which reads only, spawns nothing) and `aws_scale` in
  `actions`; its bounds, tier, schedule and events are unchanged.
  `buildInfraHealthInput` and `schemas/scheduler/infra-health-input.json`
  gain `aws`: `{ on, off_reason?, cap_usd, cost, reservations }`, where
  `cost` is `aws/cost.json` or `null`, and `reservations` the open ones from
  `aws/ledger.json` with `id`, `what`, `expected_monthly_usd`, `by`, `at` and
  `scale` (with `state`) when present; with no `aws` block, `{ on: false,
  off_reason: "no aws block", cap_usd, cost: null, reservations: [] }`. The
  prompt gains, under its limits, in these words or words that keep them:
  - an `infra_alarm` of kind `aws_forecast_over_cap` (payload `{
    forecast_usd, cap_usd, actual_usd, reserved_usd, days_to_cap }`, spec 022
    AC-9): request `aws_scale { reservation_id, direction: "down" }` for
    open reservations whose `scale.state` is `up`, largest saving
    (`up.expected_monthly_usd` minus `down.expected_monthly_usd`) first,
    until the forecast less the savings requested is at or below the cap,
    each `why` quoting the payload's figures and the saving; never for a
    released reservation or one already down (the check refuses them);
  - on a sweep, or any run, where `aws.cost.forecast_usd` is at or below
    `cap_usd` and a reservation is `down`: request `aws_scale { direction:
    "up" }` for it only when the forecast plus the difference stays at or
    below the cap (the check refuses it otherwise), one reservation per run,
    so a cap raised by the maintainer restores what was scaled down;
  - file a finding, not acting, for: an over-cap forecast that scaling every
    reservation down would not bring under the cap, naming each open
    reservation without a descriptor ("cannot scale: no descriptor") and
    saying that funds or a release by the launcher are needed; a cost the
    ledger cannot explain (`actual_usd` above what the open reservations'
    expected costs, prorated over `days_elapsed / days_in_month`, account
    for by more than 20 percent and more than 1 USD), with the figures;
  - never request `set_parameter` for `aws_cap_usd` (locked; the scheduler
    refuses it in code, spec 008 AC-12) and never ask for funds or a
    credential itself: those are findings (spec 030 section 2).
  Spec 064 AC-5's rule that an alarm of a kind it does not know is a finding
  now excludes `aws_forecast_over_cap`, which it knows. `stages.test.ts`'s
  registry test pins the prompt on `aws_forecast_over_cap` and
  `aws_scale`. The result is applied by the scheduler as every standing
  result (spec 008 AC-5); `aws_scale` goes through `applyAction` with the
  agent's `allowed` list.
- AC-9. **The policy asks for what `aws_scale` calls.** The six actions
  `aws_scale` needs (`lambda:PutFunctionConcurrency`,
  `lambda:DeleteFunctionConcurrency`, `cloudfront:GetDistributionConfig`,
  `cloudfront:UpdateDistribution`, `dynamodb:DescribeTable`,
  `dynamodb:UpdateTable`), on resources whose names start `panelator-`, are
  listed in the `aws-sso` entry's `access` (AC-1) and in `tools/README.md`
  beside spec 022's two, with the policy JSON. The implement stage raises
  them as one capability question with a `credential` request (spec 030
  AC-6: `name: aws-sso`, `provider: aws`, `access` the eight actions, `setup`
  the step of adding the statement to the `PanelatorDelivery` permission
  set) when it reaches the verification step of section 6 and the live check
  cannot pass, following spec 022 section 8's pattern; until then it builds
  and tests against the fake `aws`. Nothing under `budgets:`,
  `organizations:` or `iam:` is asked for.
- AC-10. **Live cases end to end.** Recorded worlds (`e2e.test.ts`,
  `helpers/e2e-routes.ts`; the fake `aws`, Telegram, `systemd-creds` and the
  fixture home) drive and assert:
  - `cred set aws-sso` with a profile whose fixture cache file expires in
    three days: the probe writes `expires_at` to the index without reading
    the token, the hourly step emits `credential_expiry` once, the
    credential check returns one `aws-sso` warning, one `credential-expiry`
    message reaches the fake Telegram with the login step first, logged with
    `channel: telegram`, and nothing twice that day (AC-1, AC-2);
  - the same with the fake identity returning another account: the check
    fails, `aws-access` is sent once (spec 022 AC-2), and the credential
    check warns once with the setup steps (AC-1);
  - a credential question with a complete request sent and answered "Done"
    with the check passing: two `maintainer.contact` events, `kind:
    credential`, the first `label: request` with `request`, the second
    `label: answer` with `outcome: verified`, and no `kind: question` event
    for that send (AC-3); a first-contact question denied by button:
    `outcome: denied`; a funds question answered by text: `outcome: text`;
  - a refused reservation with Telegram on: one Telegram message whose text
    has the `Amount`, `Purpose` and `Charter goal` lines and the two
    cap-raising steps, one event `{ kind: funds, channel: telegram, request
    }`, no `kind: notification` event for it; the same with the fake
    Telegram refusing: `channel: log` (AC-4, AC-5);
  - a ledger with reservation A (`scale` of kind `lambda-concurrency`, up 6
    USD, down 1 USD) and reservation B (no descriptor), a cap of 10 USD and
    a pull whose forecast is 12 USD: `infra_alarm` of kind
    `aws_forecast_over_cap` wakes infra health, whose scripted result
    requests `aws_scale` down for A; the fake `aws` records one
    `put-function-concurrency` call; the ledger shows A `down` at 1 USD,
    `forecast_usd` 7 USD, one `aws.reserve` event `outcome: scaled`, one
    `aws-forecast` recovery notification, the action log `applied` with an
    `undo` of direction `up`; the agent's finding names B as "cannot scale:
    no descriptor" (AC-6 to AC-8);
  - the next sweep with the cap raised to 20 USD: the scripted result
    requests `up` for A, the forecast ends 12 USD, A is `up` at 6 USD; a
    request for `up` again is refused "already up"; a request for a released
    reservation is refused; a request while the forecast would exceed the
    cap is refused with its reason (AC-7);
  - every earlier recorded chain (specs 006, 007, 008, 011, 013, 015, 020,
    022, 025, 026, 029, 030, 059, 064) unchanged with no `aws` block, no
    `credentials` block and Telegram off.

## 4. Marks on earlier specs

Each is prepended to the unit named, as spec 039 says; the earlier text
stays:

- Spec 030 AC-2: `Amended by [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
  AC-1: the catalogue gains the aws-sso entry; its expiry probe reads the
  CLI's SSO cache through the scheduler's own command and spawns no aws.`
- Spec 030 AC-7: `Amended by ... AC-3: the maintainer.contact event for the
  send has kind equal to the request type and carries the request.`
- Spec 030 AC-8: `Amended by ... AC-3: the answer is recorded as one
  maintainer.contact event with the request and its outcome.`
- Spec 030 AC-9: `Amended by ... AC-4: notify resolves to the channel that
  carried the notification, and the recorder sits between the rate limiter
  and the TelegramNotifier.`
- Spec 030 AC-16: `Amended by ... AC-7: aws_scale exists as a level-1 kind.`
- Spec 022 AC-6: `Amended by ... AC-6: a reservation may carry an optional
  scale descriptor written by its launcher, and its expected_monthly_usd is
  the down figure while scaled down.`
- Spec 022 AC-7: `Amended by ... AC-5: the notification's text is laid out
  as a funds request with the two cap-raising steps, and its one
  maintainer.contact event is written by the notifier's recorder from the
  notification's contact field.`
- Spec 026 AC-2: `Amended by ... AC-3 and AC-4: a maintainer.contact payload
  may carry request and outcome, its channel is telegram when the
  TelegramNotifier carried it, and a sent request has kind equal to the
  request type.`
- Spec 064 AC-5: `Amended by ... AC-8: the definition gains credentials
  aws-sso and the action aws_scale, the input gains aws, and the prompt
  handles the aws_forecast_over_cap alarm.`

(The `...` above stands for the same link in every mark.) Spec 030 AC-13 is
not marked: the credential check's rule is unchanged and `aws-sso` is one
more entry it walks. Spec 022 AC-9 is not marked: the alarm is as it was; a
subscriber now acts on it. Spec 050 AC-3 is not marked: no kind is added.

## 5. Interfaces and files

- `agents/credentials.yaml`: the `aws-sso` entry (AC-1, AC-9).
- `tools/scheduler/src/aws/sso.ts` (new): `ssoExpiry(profile, env)` (AC-2);
  `src/aws/check.ts`: `aws-check`'s expiry line uses it; `src/aws/cli.ts`:
  unchanged except that the profile may be passed per call (AC-1).
- `tools/scheduler/src/aws/scale.ts` (new): the three kinds' calls and the
  descriptor's validation (AC-6, AC-7); `src/aws/ledger.ts`: `scale` on
  `reserveSpend`'s input and the record, `scale.state`, the effective
  `expected_monthly_usd`, the `scaled` outcome (AC-6, AC-7), the `contact`
  field on the funds notification and no event of its own (AC-5).
- `tools/scheduler/src/actions/aws-scale.ts` (new): `awsScaleKind`;
  `actions/index.ts`: `KINDS.aws_scale`; `agents/actions.yaml`: the entry
  (AC-7).
- `tools/scheduler/src/credentials/check.ts` and `commands.ts`: the
  `provider: aws` path for `check` and `cred exec` through `src/aws/cli.ts`
  with the stored profile (AC-1).
- `tools/scheduler/src/notify/types.ts`: the `notify` return and `contact`
  on `Notification`; `notify/log.ts`, `notify/rate-limit.ts`,
  `notify/telegram.ts`, `notify/recorded.ts`: the return value and its use
  (AC-4); `bin/scheduler.ts`: the wiring order and the `aws sso-expiry`
  command (AC-2, AC-4).
- `tools/scheduler/src/state/questions.ts`: the `sent` contact's kind,
  label and `request` (AC-3); `src/contacts/approve.ts` (spec 030's
  pre-resume step): the answer event (AC-3).
- `tools/scheduler/src/standing/infra-health-input.ts` and
  `schemas/scheduler/infra-health-input.json`: `aws` (AC-8);
  `agents/standing/infra-health.md`: `credentials`, `actions`, the prompt
  (AC-8).
- `schemas/scheduler/event.json`: `request` and `outcome` on the
  `maintainer.contact` payload (AC-4); `schemas/scheduler/aws-ledger.json`:
  `scale` (AC-6); `schemas/scheduler/credential-catalogue.json`: nothing new
  (the entry fits spec 030's shape).
- `tools/scheduler/test/`: `aws.test.ts` (the descriptor, `aws_scale`'s
  checks and calls, the forecast after a scale, `ssoExpiry` over fixture
  files and the never-read-token assertion), `credentials.test.ts` (the
  entry, the `provider: aws` path), `notify.test.ts` (the return value, the
  recorder's channel and `contact`), `events.test.ts` (the schema's new
  properties), `actions.test.ts` (`aws_scale` in `KINDS`), `stages.test.ts`
  (the prompt pins), `e2e.test.ts` and `helpers/e2e-routes.ts` (AC-10); the
  fake `aws` under `test/helpers/` gains the AC-7 calls; a fixture home
  under `test/fixtures/aws-home/` with `.aws/config` and two cache files.
- `tools/README.md`: `aws sso-expiry`, the `aws-sso` entry, the six policy
  actions (AC-2, AC-9).
- `specs/030-beyond-github/spec.md`, `specs/022-delivery-aws-account/spec.md`,
  `specs/026-event-store/spec.md`, `specs/064-disk-sweep-and-infra-health/spec.md`:
  the marks of section 4 (this spec PR).
- `docs/delivery-system-design.md`: this spec under `## Children` (this spec
  PR).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed by the implementation except `tools/README.md`.
`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths, so the security review runs on this spec PR (the Children
line) and on the implementation PR (spec 006 AC-9). Nothing here changes the
sensitive-path list, the security criteria, what routes a sensitive diff to
the security review, that both reviews must approve, that a sensitive path
must be listed in the spec, design section 3, or any text marked as a
maintainer answer. The new `aws` calls change resource settings the ledger
already describes, never create a resource (`reserveSpend` is the only gate
to a launch, unchanged), never read the cap except to compare, and the SSO
token is never read. The locked parameter `aws_cap_usd` is still set only by
the `maintainer` actor.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added; `registryActionsCheck` passes with `aws_scale` in both
  `agents/actions.yaml` and `KINDS`; the catalogue test of spec 030 AC-2
  passes over the new entry; spec 022 AC-6's grep finds `aws` spawned only
  under `src/aws/`.
- The recorded runs of AC-10 pass, and every earlier recorded chain passes
  unchanged.
- On the laptop, with spec 022 section 8 done: `panelator-scheduler cred set
  aws-sso` with the profile name, then `cred check aws-sso` exits 0 and
  `aws sso-expiry` prints the session's expiry; the implement stage runs them
  and quotes the output in the PR. The six policy actions of AC-9 are the
  implement stage's capability question when the live `aws_scale` check
  cannot pass; until the maintainer answers, the fake `aws` covers AC-7 and
  the PR says so.
- After the service is restarted on the merged code, the first
  `credential-expiry` warning for `aws-sso`, the first `maintainer.contact`
  event with `channel: telegram`, and the first `aws_forecast_over_cap`
  alarm infra health handles (or, with the cap at 0, the first refused
  reservation's funds message) are written up in `dev-logs/` with their run
  records and event lines.

## 7. Open decisions

None.
