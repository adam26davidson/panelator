# 022. Delivery-system AWS account and spending cap

Status: written 2026-10-31 from the delivery-system design (spec F1) for
issue #37; specs derived from that design need no maintainer approval (design
section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("AWS for the delivery system"), section 6.2 (locked parameters and
the AWS cap are enforced in code), section 7 (AWS cost records are raw
events), section 11 (row F1) and section 2 (anti-goal: the delivery system's
spending never touches the product's budget); [charter](../../docs/charter.md)
(a strictly enforced cap on monthly AWS spend, configurable by the
maintainer); [product-spec](../../docs/product-spec.md) 5.4 and 5.5 (the
product's hosting and budget, which this spec leaves alone);
[008-agent-registry](../008-agent-registry/spec.md) AC-11 and AC-12 (the
`aws_cap_usd` parameter, locked, with no consumer until this spec);
[012-metrics-reflection](../012-metrics-reflection/spec.md) AC-2 (the
reserved event kind `aws.cost`) and the `maintainer.contact` kind `funds`
it reserved for F2, which this spec produces for a refused launch;
[007-telegram-channel](../007-telegram-channel/spec.md) section 8 (the
pattern for setup only the maintainer can do).

What the maintainer decided (design section 8 and the issue), kept as it is
here: the delivery system gets its own AWS account, separate from the
product's, and product hosting stays governed by product-spec 5.5; the monthly
cap applies to that account only and is a locked parameter only the maintainer
sets (`aws_cap_usd`, currently 0); the cap is enforced by AWS Budgets (an alert
at 80%, a budget action that blocks new resources at 100%, which the system's
own code cannot override) plus the scheduler's own running estimate and a
daily forecast that acts early (shrink, or ask for funds days ahead); before
launching anything an agent states the expected monthly cost, and what does
not fit becomes a funds request; the laptop stays a working fallback, so a
missed forecast means slower, not stopped; hitting the actual cap is an
incident sent to the maintainer and a planning failure for reflection; token
spend is bounded by the subscriptions, not this cap. Opening or designating
the account, giving the pipeline least-privilege access to it, and setting the
cap value are things only the maintainer can do (design section 3, item 3);
section 8 below gives the exact steps, raised as capability questions.

## 1. Goal

Give the delivery system a place to spend and a line it cannot cross:

- **An account of its own.** The scheduler talks to one AWS account, the
  delivery-system member account of the maintainer's organization, through a
  named AWS CLI profile on the laptop. It never touches the product's account
  in this spec.
- **The cap, in code.** `aws_cap_usd` becomes the planning line: nothing is
  launched whose stated monthly cost does not fit under what is left of it,
  and a refusal is a funds request. AWS Budgets is the backstop the maintainer
  sets up once in the management account, out of the pipeline's reach.
- **A running estimate and a daily forecast.** The scheduler keeps a ledger of
  what it has launched and what each thing is expected to cost per month,
  pulls the account's actual month-to-date spend once a day, forecasts the
  month, and acts early when the forecast crosses the cap: launches stop,
  standing agents are woken to shrink, and the maintainer is asked for funds
  days ahead. Every pull is an `aws.cost` event.
- **Nothing moves to the cloud here.** This spec launches no resource. It is
  the account, the access, the cap's consumer, the launch gate and the
  forecast that spec E (the console's hosting) and spec F2 (infra health,
  scaling, funds requests over Telegram) build on. With no profile configured
  the scheduler runs exactly as it does today.

## 2. Out of scope

- Any resource in the account: the console's hosting (spec E) and whatever
  infra health operates (spec F2) are the first launchers; each states its
  cost through the gate of AC-6.
- The product's AWS account, its hosting, budget page and degradation ladder
  (product-spec 5.4, 5.5; design section 2). Nothing here reads or writes it.
- The encrypted credential store and wrappers, the credential check agent and
  its early warning before the SSO session expires, the infra health agent
  that shrinks on an alarm, and funds requests over Telegram (spec F2). Here
  the AWS CLI's own SSO configuration on the laptop is the credential, a
  refused launch is a notification through the `Notifier` (the service log
  today, Telegram once F2 routes it), and the forecast's alarm wakes whatever
  subscribes to `infra_alarm` (nothing until F2).
- The console's AWS tile (design section 9: spend against the cap, spec E).
  Until E lands, `panelator-scheduler aws` on the laptop is the view (AC-10).
- Changing the parameter store, the lock rule, or the modes of spec 008: the
  cap stays a `locked` number set only by the `maintainer` actor.
- A token-spend cap. The charter bounds tokens by the subscriptions (spec 013
  plans around them).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001,
and a fake `aws` command on `PATH` (section 6) that answers the calls of AC-2
and AC-4 from fixture files. "AWS on" means the `aws` block of AC-1 is
configured and the identity check of AC-2 passed at service start or at the
last daily pull. Definitions: *month* is the calendar month in UTC; *cap* is
the value of `aws_cap_usd`; *actual* is the account's month-to-date cost from
the last pull (AC-4); *reserved* is the sum of the expected monthly cost of
the open reservations in the ledger (AC-6).

**Account and access**

- AC-1. **One account, one profile, outside the repository.**
  `agents/scheduler.yaml` gains an `aws` block: `profile` (the AWS CLI
  profile name, default `panelator-delivery`), `account_id` (the
  delivery-system account's twelve digits), `region` (default `us-east-2`)
  and `pull_interval_h` (default 24, min 6). Given the block is absent, when
  the service starts, then AWS is off: the service log records `aws: off`
  with the reason, once, and every behaviour of earlier specs stays as it is
  (the recorded chains of specs 006, 007, 008, 012 and 013 pass unchanged).
  An `aws` block with an unknown key, or an `account_id` that is not twelve
  digits, fails config validation (spec 001 AC-1 rules). No access key,
  token or SSO cache content is ever written to the service log, a run
  record, a stage's environment or prompt, or any file in the repository; a
  test asserts the log and a stage's environment after a pull. The scheduler
  calls AWS only through the `aws` command with `--profile <profile>` and
  `--region <region>`, never through an SDK, so the credential stays the
  CLI's and F2 can wrap it as it wraps `gh`.
- AC-2. **The identity is checked before anything else.** Given the block is
  present, when the service starts and before each pull, then the scheduler
  runs `aws sts get-caller-identity`; given it returns the configured
  `account_id`, then AWS is on. Given it fails (no profile, an expired SSO
  session, a network error) or returns another account, then AWS is off with
  that reason, logged once per change of state, one notification (label
  `aws-access`, spec 001's `Notifier`) is sent, no other AWS call is made,
  and the service keeps running. A different account id is never used: a
  test with a fake identity in another account asserts that no call other
  than the identity check is made.
- AC-3. **Setup can be checked.** `panelator-scheduler aws-check` runs the
  identity check, then `aws ce get-cost-and-usage` for the current month, and
  prints: the caller ARN and account, whether it matches the configuration,
  the month-to-date cost, the cap, and the SSO session expiry read from the
  profile's cached token (`expiresAt` of the matching file under
  `~/.aws/sso/cache/`, or "not SSO"). Its exit status is 0 only when the
  identity matches and the cost call succeeded. It is the step the implement
  stage runs after the maintainer completes section 8.

**The daily pull and the forecast** (design section 8)

- AC-4. **Actual spend is pulled once a day and recorded.** Given AWS on and
  the last successful pull older than `pull_interval_h` (or none yet), then
  the tick runs `aws ce get-cost-and-usage` for the current month at
  `MONTHLY` granularity, metric `UnblendedCost`, filtered to the configured
  `account_id` (a member account sees only its own costs; the filter is a
  second guard), and writes `aws/cost.json` in the state directory: `month`,
  `actual_usd`, `as_of` (the pull time), `cap_usd` (the cap at the pull),
  `reserved_usd`, `forecast_usd` (AC-5), `days_elapsed`, `days_in_month`,
  `source: ce`. One `aws.cost` event (spec 012's reserved kind) with that
  payload is recorded beside the write. Given the call fails, then the
  previous `cost.json` is kept, the failure is logged, and the pull is
  retried at the next tick after one hour, at most six times a day. Given
  a new month, then `actual_usd` starts from the new month's figure and the
  per-month notifications of AC-8 reset. Cost Explorer charges about one
  cent per call; the default interval is one call a day.
- AC-5. **The forecast is the larger of two views.** `forecast_usd` is the
  greater of: the trend, `actual_usd / max(days_elapsed, 1) × days_in_month`;
  and the ledger view, `actual_usd + reserved_usd × days_remaining /
  days_in_month`. It is computed at every pull and whenever the ledger
  changes (AC-6), from the last pulled `actual_usd`. The forecast is the
  scheduler's own, so a lag of up to a day in AWS's cost data does not hide
  what the system itself just launched. *(agent's call: two views, the
  larger wins)*

**The launch gate and the running estimate** (design section 8)

- AC-6. **Nothing is launched without a stated cost that fits.** The ledger
  `aws/ledger.json` holds reservations `{ id, what, expected_monthly_usd,
  why, by (agent or run id), at, released_at? }`. `reserveSpend(ctx, { what,
  expected_monthly_usd, why, by })` in `tools/scheduler/src/aws/ledger.ts` is
  the one function any code that creates a billable resource must call
  first; specs E and F2 name it, and a test greps `tools/scheduler/src/` for
  `aws` invocations outside `src/aws/` and asserts there are none. Given AWS
  on, `expected_monthly_usd` a number at least 0, `what` and `why` each at
  least 10 characters, and `forecast_usd` recomputed with the reservation
  added (AC-5) at or below the cap, then the reservation is written with
  `released_at: null` and returned `{ ok: true, id }`, and an `aws.reserve`
  event `{ id, what, expected_monthly_usd, why, by, outcome: "reserved" }`
  is recorded. Given it would push the forecast over the cap, AWS is off, or
  the cap is 0, then nothing is written, `{ ok: false, reason, shortfall_usd
  }` is returned, the same event is recorded with `outcome: "refused"`, and
  the refusal is a funds request (AC-7). `releaseSpend(ctx, id)` sets
  `released_at` and records `outcome: "released"`. A reservation's cost
  counts in `reserved_usd` until released. No reservation is a
  permission: AWS Budgets' action at 100% (section 8) still applies to a
  launch the ledger allowed, and the ledger is the system's record, not a
  store outside its reach (design section 6.2).
- AC-7. **A refusal is a funds request.** Given a refused reservation, then
  one notification is sent through the `Notifier` with label `aws-funds`
  and a text giving what, the expected monthly cost, the shortfall against
  the cap, the forecast and the charter goal the `why` names, and a
  `maintainer.contact` event with `kind: funds` is recorded (spec 012 AC-2:
  the kind F2 will carry to Telegram). The same `what` is not notified
  again within `notify_rate_limit_hours`.

**Acting early, and the incident**

- AC-8. **Thresholds are notified once a month each.** Given a pull with
  `actual_usd` at or above 80% of a non-zero cap, then one notification with
  label `aws-cap-80` is sent for that month; at or above 100%, one with
  label `aws-cap-hit` headed "incident", and one finding is appended to the
  findings queue with `what` starting `AWS cap hit: planning failure`,
  evidence the month's `aws.cost` payloads and the ledger, so the filer and
  reflection treat it as the design says. A second pull in the same month
  above the same threshold sends nothing more. The maintainer's own alerts
  from AWS Budgets (section 8) arrive by email independently of this.
- AC-9. **An over-cap forecast stops launches and wakes the shrinkers.**
  Given `forecast_usd` above a non-zero cap after a pull or a ledger change,
  then: `reserveSpend` refuses every new reservation while it stays above
  (AC-6); the event `infra_alarm` is emitted (spec 008 AC-4, until now with
  no producer) with payload `{ kind: "aws_forecast_over_cap", forecast_usd,
  cap_usd, actual_usd, reserved_usd, days_to_cap }` where `days_to_cap` is
  the days until the trend reaches the cap (0 when already at it), so a
  subscribing agent (F2's infra health) can shrink; and one notification
  with label `aws-forecast` is sent, at most once a day while the forecast
  stays above, saying how many days remain at the current rate, what is
  reserved, and the shortfall, which is the "ask for funds days ahead" of
  the design. Given the forecast falls back under the cap, then
  reservations are allowed again and a `aws-forecast` notification says so,
  once.

**Visibility**

- AC-10. **The book is visible.** `panelator-scheduler aws` prints
  `cost.json`, the open reservations, the released ones of the current
  month, whether AWS is on and why not, and the last pull's time, as a
  table or with `--json`. `panelator-scheduler aws pull` forces a pull now.
  Given a tick while AWS is on, then the tick's service-log line carries
  `aws: { actual_usd, forecast_usd, cap_usd, reserved_usd, as_of }`; while
  AWS is off, `aws: { off: <reason> }`.
- AC-11. **The cap is read, never written.** The scheduler reads
  `aws_cap_usd` from the parameter store at each pull and each reservation.
  No code under `src/aws/` calls `setParameter` or `setParameterMode`, and
  no action kind this spec adds exists: a test asserts both. Given the
  maintainer runs `param set aws_cap_usd <n>` (spec 008 AC-17), then the
  next tick recomputes the forecast and the AC-9 state against the new cap
  without a pull.

## 4. Design notes (agent's calls)

- **The pipeline cannot reach the budget.** The design says the budget
  action is one "the system's own code cannot override". A budget the
  scheduler could modify would move the line whenever the scheduler changed
  the amount, so the budget lives in the organization's management account,
  where the pipeline has no access at all, scoped to the delivery account by
  its linked-account filter, and its 100% action is a service control policy
  applied to the delivery account. The pipeline's permissions (section 8)
  include nothing under `budgets:` or `organizations:`. The cost of this is
  that raising the cap is two steps for the maintainer, the parameter and
  the budget amount; the steps say so, and whichever is lower bites first.
- **Cost Explorer, not the budget, is what the scheduler reads.** The budget
  is in an account the pipeline cannot see. `ce:GetCostAndUsage` from the
  member account gives the same month-to-date figure for about a cent a day,
  needs only the organization's "linked account access" switch, and is what
  product-spec 5.5's budget page already uses on the product side.
- **A ledger, not an estimate from prices.** The design wants an agent to
  state expected monthly cost before launching; the ledger records exactly
  that statement and holds the agent to it. The forecast's ledger view makes
  a just-launched resource count at once, before AWS reports it; the trend
  view catches cost the ledger does not know about (a forgotten resource,
  data transfer). Taking the larger errs toward stopping early, which is
  what "act early" asks for.
- **One profile, the CLI, no SDK.** The laptop's `aws` CLI already holds the
  maintainer's SSO configuration, F2's wrappers are built around commands
  as the `gh` wrapper is, and a second profile for a second account is one
  stanza in `~/.aws/config`. The cost is a process spawn per call, a few
  calls a day.
- **`infra_alarm`, not a new event.** Spec 008 reserved the name for exactly
  this: an infrastructure alarm that wakes a standing agent. F2's infra
  health subscribes; until then the event is recorded and nothing runs.
- **Refusals notify through the `Notifier`.** F2 owns funds requests on
  Telegram. The refusal here carries everything a funds request needs (what,
  amount, charter goal), so F2 routes it rather than reinvents it.

## 5. Interfaces and files

- `tools/scheduler/src/aws/`:
  - `cli.ts`: the one place `aws` is spawned (`--profile`, `--region`,
    `--output json`, a timeout), with the command path injectable for the
    fake (AC-1);
  - `identity.ts`: the identity check and the on/off state (AC-2);
  - `cost.ts`: the pull, `cost.json`, the forecast, the threshold and
    forecast notifications, the `infra_alarm` emit (AC-4, AC-5, AC-8, AC-9);
  - `ledger.ts`: `reserveSpend`, `releaseSpend`, `ledger.json`, the funds
    notification (AC-6, AC-7);
  - `check.ts`: `aws-check` (AC-3) and the `aws` command's output (AC-10).
- `tools/scheduler/src/service/loop.ts`: the pull step of a tick (after the
  resumes, before the standing agents), the tick summary's `aws` field, the
  recompute after a cap change (AC-10, AC-11).
- `tools/scheduler/src/config.ts` and `agents/scheduler.yaml`: the `aws`
  block (AC-1).
- `tools/scheduler/src/state/paths.ts`: `aws/cost.json`, `aws/ledger.json`.
- `tools/scheduler/src/events/kinds.ts` and `schemas/scheduler/event.json`:
  the payload schema for `aws.cost`, the new kind `aws.reserve`, and `funds`
  among `maintainer.contact` kinds (AC-4, AC-6, AC-7).
- `tools/scheduler/src/standing/events.ts`: the `infra_alarm` producer
  (AC-9).
- `tools/scheduler/bin/scheduler.ts`: `aws`, `aws pull`, `aws-check`.
- `agents/parameters.yaml`: the description of `aws_cap_usd` names this spec
  as its consumer; type, default, range and mode unchanged.
- `schemas/scheduler/`: `aws-cost.json`, `aws-ledger.json`,
  `scheduler-config.json` (if the config has a schema) gain the fields above.
- `tools/scheduler/test/`: `aws.test.ts` (identity, pull, forecast arithmetic
  for both views and the month boundary, reservations and refusals, the
  thresholds once per month, the forecast alarm and its recovery, the
  no-`aws`-outside-`src/aws/` grep, the no-`setParameter` assertion, the
  secrets-never-logged assertion), `config.test.ts` (AC-1), `loop.test.ts`
  (the pull step, the tick field), and the recorded runs of section 6 in
  `e2e.test.ts`; the fake `aws` command under `test/helpers/`.
- `tools/README.md`: the three commands and the `aws` block (documentation
  of the tool, in its own package).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed by the implementation except `tools/README.md`.
`tools/scheduler/` and `agents/` are sensitive paths, so the security review
runs on the PR as spec 006 AC-9 says. Nothing here changes the sensitive-path
list, the security criteria, or what routes a sensitive diff to the security
review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including recorded end-to-end runs (fake adapter, mocked GitHub, fake `aws`
  command) for:
  - no `aws` block: every earlier recorded chain unchanged, `aws: off` once;
  - the identity returning another account: no further call, one
    `aws-access` notification;
  - a pull writing `cost.json` and one `aws.cost` event, a second tick
    inside the interval pulling nothing, a failed pull retried after an hour;
  - a reservation that fits, one that does not (refused, `aws-funds`
    notification, `maintainer.contact` kind `funds`), one refused because the
    cap is 0, and a release;
  - a month at 85% then 100%: one `aws-cap-80`, one `aws-cap-hit`, one
    planning-failure finding, nothing twice; a new month resetting them;
  - a forecast over the cap from a reservation: `infra_alarm` emitted, one
    `aws-forecast` a day, reservations refused, then the forecast back under
    the cap and one recovery notification;
  - `param set aws_cap_usd` raising the cap: the next tick allows what was
    refused, with no pull.
- With section 8 done, `panelator-scheduler aws-check` exits 0 on the laptop;
  the implement stage runs it and quotes its output in the PR.
- After the service is restarted on the merged code, the first real pull
  (`aws` output, the `aws.cost` event, the service-log line) is written up in
  `dev-logs/`.

## 7. Open decisions

None.

## 8. Setup the maintainer does (the capabilities this spec needs)

Three things here are the maintainer's alone (design section 3, item 3): the
account, the pipeline's access to it, and the cap value. The implement stage
raises them as questions of kind `capability` through the question check,
with the steps below copied in, when it reaches the verification step of
section 6 and `aws-check` cannot pass: one question for each item still
missing, in this order, each only when the earlier ones are done. The first
question carries all three parts so the maintainer can do them in one
sitting; a later one repeats only what is left. Until then the stage builds
and tests against the fake `aws` command, and the service runs with AWS off.
The answer to each is "done" (with the account id and the profile name for
the first two), or the failing step; nothing is recorded in the repository
for it beyond the questions log (spec 006 AC-18) and the `aws` block of
`agents/scheduler.yaml`, which the implement stage fills in from the answer.

The organization already exists (id `o-u5lgoaum8l`, management account
`336231940806`, one member so far, which is the product's), and the laptop's
default profile is an SSO `AdministratorAccess` session on that management
account, so every step below runs from the laptop as the maintainer.

**1. Open the account** (an Organizations member account; a brand-new
standalone account would need its own payment method and would sit outside
the organization's budget and policies, so it is not recommended):

```
aws organizations create-account \
  --account-name panelator-delivery \
  --email adam26davidson+panelator-delivery@gmail.com
aws organizations describe-create-account-status --create-account-request-id <Id from above>
```

Wait until `State` is `SUCCEEDED` and note `AccountId` (twelve digits). Then
in the console, Billing and Cost Management, Cost Explorer, Preferences, turn
on **Linked account access**, so the new account can read its own costs.

**2. Give the pipeline least-privilege access.** Two options; the first is
recommended.

- *Option A, an SSO permission set (recommended: no long-lived key, and the
  laptop's CLI already uses this SSO session).* In IAM Identity Center:
  Permission sets, Create, Custom, name `PanelatorDelivery`, with this inline
  policy and nothing else; then AWS accounts, select `panelator-delivery`,
  Assign users, choose your user, choose `PanelatorDelivery`. In Settings,
  Authentication, Session settings, set the access portal session to its
  maximum (90 days), so the laptop's refresh token outlives a normal gap
  between logins; F2's credential check will warn before it expires.

  ```json
  { "Version": "2012-10-17", "Statement": [
    { "Effect": "Allow", "Action": [ "sts:GetCallerIdentity",
      "ce:GetCostAndUsage", "ce:GetCostForecast" ], "Resource": "*" } ] }
  ```

  Then add to `~/.aws/config` on the laptop:

  ```
  [profile panelator-delivery]
  sso_session = default
  sso_account_id = <AccountId from step 1>
  sso_role_name = PanelatorDelivery
  region = us-east-2
  output = json
  ```

  and run `aws sso login --sso-session default`, then
  `aws sts get-caller-identity --profile panelator-delivery`.

  Cost: the session must be renewed by hand when it expires (at most every
  90 days), a few seconds on the laptop.

- *Option B, an IAM user with an access key in the new account.* Sign in to
  `panelator-delivery` as `OrganizationAccountAccessRole` (switch role from
  the management account), create user `panelator-pipeline` with the same
  inline policy, create an access key, and add a `[profile
  panelator-delivery]` with `aws_access_key_id` and `aws_secret_access_key`
  in `~/.aws/credentials` (`chmod 600`). Cost: a long-lived secret on the
  laptop until F2's encrypted store exists, and key rotation is a manual
  step with no expiry to warn on.

Later specs (E, F2) will each ask for the extra actions they need, added to
the same policy; this spec needs only the three above.

**3. Set the cap, in both places.** The planning line in the scheduler:

```
panelator-scheduler param set aws_cap_usd <amount>
```

(0 stays allowed and means "launch nothing"). And the backstop in AWS, in the
management account (the only place a budget action can apply a service control
policy): Billing and Cost Management, Budgets, Create budget, Customize, Cost
budget, name `panelator-delivery-cap`, Monthly, Fixed, amount `<amount>`,
filter **Linked account** = `panelator-delivery`; alert 1: threshold 80% of
budgeted amount, Actual, email to you; alert 2: threshold 100%, Actual, email
to you, and an action: **Apply a service control policy**, target the
`panelator-delivery` account, execution **Run automatically** (not "requires
approval"), with a new policy `panelator-delivery-cap-block` created first
under AWS Organizations, Policies, Service control policies:

```json
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Deny", "Resource": "*",
  "Action": [ "ec2:RunInstances", "ec2:CreateVolume", "ec2:AllocateAddress",
    "ecs:CreateCluster", "ecs:CreateService", "ecs:RunTask",
    "lambda:CreateFunction", "apprunner:CreateService", "lightsail:Create*",
    "rds:CreateDBInstance", "rds:CreateDBCluster", "dynamodb:CreateTable",
    "s3:CreateBucket", "cloudfront:CreateDistribution",
    "elasticloadbalancing:CreateLoadBalancer", "eks:CreateCluster",
    "elasticache:CreateCacheCluster", "cloudformation:CreateStack",
    "amplify:CreateApp", "codebuild:CreateProject" ] } ] }
```

(The first time, Budgets asks to create its service role for actions; accept.
The list blocks creating what the delivery system is likely to use; a later
spec that launches another kind of resource asks, in its own capability
question, for its create action to be added.) When the cap changes later,
change the parameter and the budget amount together; the policy and the
alerts stay.
