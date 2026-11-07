# 051. The maintainer console

Status: written 2026-11-07 from the delivery-system design (row E, second
part: the console of section 9) for issue #101, recovering the console spec
written as `specs/030-console/spec.md` in commit cfa33fb and left out of PR
#96 (spec 006 AC-21 allows one spec directory per spec PR; the number 030
has since been used); specs derived from that design need no maintainer
approval (design section 11). **Needs specs 022 and 027 on `main`**: the
plan stage checks, before planning, that `tools/scheduler/src/aws/ledger.ts`
(spec 022's `reserveSpend`) and `tools/scheduler/src/metrics/` (spec 027's
`computeMetrics`) exist on `main`, and given either is missing it plans
nothing and returns `spec_gap` naming the missing spec, so nothing is built
against code that is not there. Its `design/` is produced by spec 029's
design stage (on `main` since PR #104) when the UI-design gate finds it
missing, before any plan. Marks no other spec.
Class: tooling. Domain: web-ui.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 3 ("What happens while it waits": questions listed on the console),
6.2 (console exposure of new agents, parameters and metrics), 8 ("AWS for the
delivery system"), 9 ("The console"), 11 (row E) and 13 (the console's stack
details and how state is pushed and changes pulled are left to the builder);
[ADR 0005](../../docs/decisions/0005-console-static-site-small-api.md)
(static site, small API, long-poll pull); [charter](../../docs/charter.md)
(a secure, hosted, mobile-friendly interface; parameters set to auto or
locked; the UI kept up to date); [design-tree](../../docs/design-tree.md)
R5.Q4 (the front-end toolchain); [spec 008](../008-agent-registry/spec.md)
(parameters, actions, undo, pause, the `maintainer` actor);
[spec 038](../038-param-mode-leaves-the-action-log/spec.md) (a mode change is
recorded in the parameter history, not the action log);
[spec 022](../022-delivery-aws-account/spec.md) AC-6 (`reserveSpend`), the
`aws` wrapper of its section 5 and its section 8 (the pattern for setup only
the maintainer can do); [spec 050](../050-infra-alarm-kind-and-aws-cap-zero/spec.md)
(reservations are refused while the cap is 0);
[spec 027](../027-metrics/spec.md) AC-1 (the seed metrics) and AC-5 (the
metrics report); [spec 007](../007-telegram-channel/spec.md) (the Telegram
thread and the long-poll pattern); [spec 006](../006-no-human-stops/spec.md)
AC-18 (the questions log) and AC-20 (the UI-design park);
[spec 029](../029-design-stage/spec.md) (the design stage, its renderer and
the toolchain catalog of its AC-6); [spec 016](../016-fair-slot-scheduling/spec.md)
(more than one claim may run at once).

What the maintainer decided (design section 9 and issue #38), kept as it is
here: home screen direction A; every screen designed and reviewed at mobile,
tablet and desktop; parameters each with an auto or locked switch; sign-in
only for the maintainer's GitHub login; nothing connects in to the laptop,
the scheduler pushes state and pulls changes; a delivery-system package
separate from `web/` reusing its React toolchain; hosted in the delivery
account against its cap. Creating the GitHub OAuth app and choosing a domain
are the maintainer's alone (section 9 below).

## 1. Goal

Give the maintainer the charter's interface: from a phone, tablet or laptop,
signed in with GitHub, see what the system is doing now, what it asks, how it
has performed over time, what it did on its own, and set or lock its
parameters. Six screens in a `console/` package, hosted as ADR 0005 says, fed
by a state snapshot the scheduler pushes at every tick, and steering the
scheduler through changes it pulls and applies as the `maintainer` actor
through the paths spec 008 already provides. Everything the console shows
comes from the snapshot, and the snapshot carries lists, so a new agent,
parameter or metric appears without a console change.

## 2. Out of scope

- The look of the screens: spec 029's design stage decides it in
  `specs/051-console/design/`, within direction A and section 7 here.
- Hosting anywhere but the delivery account. Given AWS off (spec 022 AC-2),
  the cap 0, or a refused reservation, the implementation builds and tests,
  deploys nothing, and says so in its PR.
- Intake, grilling or answering questions from the console: a question is
  answered on Telegram or GitHub as spec 007 says; the console links to the
  thread.
- Any access for anyone but the maintainer's login; no roles, no read-only
  guests.
- Changing the parameter store, the lock rule, the action kinds, the action
  log's schema or the questions log; the console calls what spec 008
  provides. `run_agent` and `rerun_workflow` are not offered.
- Writing to the laptop from the cloud: no webhook, port or SSH; the API
  only answers the scheduler's requests.
- The product's web app in `web/`.
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review.

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API and a fake `aws`
command, as in specs 001 and 022; the API is exercised in tests through its
handler functions with an in-memory table, and the app through Vitest with
Testing Library and the stories in `design/`. *Snapshot* is the
`console-state` document of AC-2. *Change* is a `console-change` document of
AC-4.

**The scheduler side**

- AC-1. **Configured, or absent.** `agents/scheduler.yaml` accepts a
  `console` block: `url` (the API base), `credentials_path` (default
  `~/.config/panelator/console.json`, holding the scheduler's API key
  written by the deploy of AC-7, never in the repository, a log, a run
  record or a stage environment), `github_client_id` (not a secret),
  `push_min_s` (default 30, at least 5), `long_poll_s` (default 25, from 1
  to 28); an unknown key is a config error, as for the `telegram` block. The
  maintainer login is the existing top-level `maintainer`. Given the block
  is absent, then the console is off, logged once at start, and every
  behaviour of earlier specs is unchanged (the recorded chains in
  `tools/scheduler/test/e2e.test.ts` pass unchanged). A test asserts the key
  appears in no log line, run record or stage environment.
- AC-2. **The snapshot.** `buildConsoleState(ctx)` in
  `tools/scheduler/src/console/state.ts` returns `console-state`
  (`schemas/scheduler/console-state.json`):
  - `generated_at`, and `tick_s` (the poll interval, so the app can judge
    staleness);
  - `questions: [{ question_comment_id, issue, kind, text, options,
    asked_at, status: open | reminded | answered, answered_at?,
    question_url, decision_url?, telegram_url? }]` from the questions log
    (spec 006 AC-18), one per `question_comment_id`, newest event deciding
    the status; `question_url` and `decision_url` are the GitHub links of
    the question comment and the reply comment; `telegram_url` is
    `https://t.me/<bot username>` when the Telegram poller has connected and
    reported its username (a private chat has no web link to one message,
    so the chat is the nearest link);
  - `current: [{ issue, title, stage, stages: [{ name, status: done |
    running | pending | failed }], model, started_at, elapsed_s, cost_usd,
    pr? }]`, one per active claim, oldest first, from the claims and their
    run records; stages in the order plan, implement, verify, review, fix,
    merge, with the spec and design tracks shown as one stage named for the
    track; empty when idle, and then `next_tick_at`;
  - `up_next: [{ issue, title, class }]` from the shortlist's next picks;
  - `tiles: { merged_per_week, issue_to_merge_days, rework_per_merge, aws:
    { actual_usd, forecast_usd, cap_usd } }`: each metric tile the value
    of the latest complete weekly bucket of that seed metric (spec 027
    AC-1) in the report below, and `aws` from `aws/cost.json` and the
    `aws_cap_usd` parameter; a field is null when its source is absent;
  - `metrics`: the `metrics-report` of spec 027 AC-5 over the last 52
    weeks, replaced metrics included, or null;
  - `actions`: the last 200 entries of the action log with their `undo` and
    status;
  - `agents: [{ name, last_run, next_run, cost_30d_usd, paused, paused_by
    }]` from the registry and agent state;
  - `parameters: [{ name, type, value, mode, min?, max?, description, at,
    set_by }]` from the parameter definitions and store;
  - `changes: [{ id, kind, args, at, status: pending | applied | refused,
    reason? }]`: the last 50 changes received, with their outcome.

  Given a source file is missing, then its field is null or empty and the
  snapshot is still valid against the schema.
- AC-3. **Push on change, at least every tick.** Given the console on, then
  the tick (after spec 022's pull step) builds the snapshot and, given it
  differs from the last pushed one apart from `generated_at`, or
  `push_min_s` has passed, `PUT`s it to `<url>/state` with the API key; a
  question asked, answered or reminded, a claim change, an action applied
  and a parameter change each trigger a push outside the tick, debounced to
  one per `push_min_s`, except that a change's own outcome (AC-4) is pushed
  at once. Given the push fails, then it is logged once per change of
  outcome and retried at the next tick; nothing else waits on it.
  `panelator-scheduler console state` prints the snapshot (the laptop
  fallback of design section 8).
- AC-4. **Changes are pulled over a held connection and applied as the
  maintainer.** Given the console on, then the service holds a long-poll
  `GET <url>/changes?after=<cursor>&wait=<long_poll_s>` open at all times,
  as spec 007's poller does for Telegram, reconnecting on return and with
  backoff on error; nothing listens on the laptop. Each change `{ id, at,
  by, kind, args }` (`schemas/scheduler/console-change.json`) is applied at
  once:
  - `set_parameter` `{ name, value }`, `pause_agent` `{ name }` and
    `resume_agent` `{ name }` through `applyAction` with `agent:
    "maintainer"`, `run_id: "console:<change id>"`, the kind, and allowed
    `'maintainer'`, as the `param set` and `agent pause|resume` commands do;
  - `undo` `{ action_id }` through the action log's undo as `maintainer`,
    its row carrying `run_id: "console:<change id>"`;
  - `set_parameter_mode` `{ name, mode }` through `setParameterModeCommand`,
    as the `param mode` command does: recorded in
    `parameters/history.jsonl` with actor `maintainer` and not in the
    action log (spec 038).

  Any other kind, a malformed `args`, an unknown name or a value the
  definition refuses is a refusal with its reason, applied to nothing. Each
  change and its outcome (`applied` with the action id when there is one,
  or `refused` with the reason) is appended to `console/changes.jsonl` in
  the state directory, whose last id is the cursor; given the same `id`
  arrives twice, then it is applied once and its recorded outcome is
  reported again. The outcome is `POST`ed to `<url>/changes/<id>/result`
  and a push follows, so the console shows it within seconds.

**The hosted side**

- AC-5. **Sign-in for one login.** `GET /auth/login` starts GitHub OAuth
  with the app of section 9 and a random `state` held in a short-lived
  cookie; the callback checks `state`, exchanges the code, reads the login,
  and given it equals the configured maintainer login, creates a session (a
  random id stored in the table with the login and an expiry 30 days out)
  and sets it as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; given any
  other login or a `state` mismatch, it returns 403 with no session and
  records the attempt. Every other route except the static assets and
  `/auth/*` requires a valid session (browser routes `GET /state`, `POST
  /changes`) or the scheduler's API key (`PUT /state`, `GET /changes`,
  `POST /changes/<id>/result`); the key never works for browser routes and
  the cookie never for scheduler routes. `POST /changes` also requires a
  same-origin `Origin` header. `POST /auth/logout` deletes the session.
- AC-6. **The API.** One DynamoDB table holds the latest snapshot, the
  change queue with outcomes, and sessions. `GET /state` returns the latest
  snapshot and its age; `POST /changes` (session) checks the kind is one of
  AC-4's five, appends the change with a new, increasing id and `by` set to
  the session's login, and returns it; `GET /changes?after&wait` (key)
  returns the changes after `after` at once, or holds for up to
  `min(wait, 28)` seconds (inside API Gateway's 29-second limit, so the
  scheduler's `long_poll_s` is a reconnect cadence), reading the table
  every 2 seconds, and returns empty at the end; `POST
  /changes/<id>/result` (key) stores the outcome. The key is checked
  against its SHA-256 hash, a stack parameter. Handlers are plain functions
  in `console/api/` tested with an in-memory table; the Lambda entry points
  wrap them.
- AC-7. **Deployed by the scheduler, inside the cap.**
  `console/infra/stack.yaml` is one CloudFormation stack (S3 bucket,
  CloudFront distribution, HTTP API, Lambda functions, the table, their IAM
  role, and with a domain the Route 53 records and ACM certificate).
  `panelator-scheduler console deploy` first calls `reserveSpend` with
  `what: "maintainer console (CloudFront, Lambda, DynamoDB)"`,
  `expected_monthly_usd` the constant `CONSOLE_MONTHLY_USD` in
  `tools/scheduler/src/console/deploy.ts` (2, with its derivation in a
  comment), and `why` naming the charter's interface requirement; given it
  is refused (the cap 0 included, spec 050) or AWS is off, then nothing is
  deployed and the command exits non-zero with the reason. Given it is
  reserved, then it generates the API key, runs `aws cloudformation deploy`
  through spec 022's `aws/cli.ts` with the maintainer login, the OAuth
  client id and the key's hash as parameters (the hash `NoEcho`), builds
  the app, syncs it to the bucket, invalidates the distribution, writes the
  key to `credentials_path` with mode 0600 and prints the console URL. The
  client secret is read by the sign-in Lambda from the SSM parameter the
  maintainer created (section 9) and never passed on a command line. A
  second deploy keeps the reservation and the key. `panelator-scheduler
  console destroy` deletes the stack, then releases the reservation. No
  `aws` process is spawned outside `tools/scheduler/src/aws/` (spec 022
  AC-6's test).

**The screens**

- AC-8. **Home (direction A).** Given a signed-in maintainer on any
  viewport, then Home shows: a banner with the count of open questions
  linking to Questions, absent when there are none; one large card for the
  oldest entry of `current` (issue, title, the stage progress with the
  running stage marked, model, elapsed, cost so far, link to the PR), any
  further running claims as compact rows under it, or "idle" with the next
  tick time; "up next" with the first three of `up_next`; four stat tiles,
  merged per week, median issue-to-merge, rework, and AWS spend against the
  cap (actual, forecast and cap; a cap of 0 is shown as "cap 0: nothing may
  be launched"); a null tile shows "no data". On tablet and desktop the
  extra width is laid out as the design decides.
- AC-9. **Questions.** Open first, then answered, each with its issue, kind,
  text, options, when asked, status, a link to the question on GitHub, to
  the Telegram chat when `telegram_url` is present, and to the decision
  record when answered.
- AC-10. **History.** Every metric of the report over its weekly buckets as
  a chart, with the window selectable (4, 12, 26, 52 weeks); a replaced
  metric is drawn beside its replacement for as long as the report carries
  both; a null bucket is a gap, not a zero.
- AC-11. **Actions.** The action log newest first, each with what, why,
  which agent, when, status, and an **Undo** control when `undo` is not null
  and the entry is `applied`; pressing it posts an `undo` change and shows
  the entry as pending until the change's outcome arrives, then the
  outcome.
- AC-12. **Agents.** Each standing agent with last run, next run, cost over
  30 days and a **Pause** or **Resume** control posting the change; an agent
  paused by the maintainer says so.
- AC-13. **Parameters.** Each parameter with its description, value, limits
  and an **auto / locked** switch; a value edit posts `set_parameter`, the
  switch posts `set_parameter_mode`; a locked parameter shows that the
  system cannot change it; a pending change is shown until its outcome
  arrives and a refusal shows its reason.
- AC-14. **Freshness and failure are visible.** Every screen shows the
  snapshot's age; older than three times `tick_s` it is marked stale. Given
  the API unreachable, then the app says so and keeps the last snapshot it
  had. Given no session, then every screen leads to sign-in.

## 4. Design notes (agent's calls)

- **Lists, not fields, in the snapshot.** Design 6.2 wants the console to
  keep up with the system. A console that renders lists of parameters,
  agents, metrics and actions needs no change when one is added.
- **Pull, not push, for changes,** because the design says nothing connects
  in to the laptop. API Gateway's 29-second cap on a request makes "held
  open" a reconnect loop, which is what the Telegram poller already is; the
  default `long_poll_s` of 25 keeps each request inside it.
- **The maintainer actor is the console's only actor,** and every change
  goes through the path its command-line twin uses, so the console adds no
  way to change state that the command line does not have. Sign-in admits
  one login and every change is applied as `maintainer`, so the lock rule of
  spec 008 is exactly the charter's: locked means the system cannot change
  it, the maintainer can.
- **No new action-log fields.** The cfa33fb text gave the action log `via`
  and `change_id` fields and logged mode changes there. Spec 038 has since
  made `applyAction` the log's one writer and moved mode changes to the
  parameter history, and the log's schema forbids extra fields. The
  existing `run_id` field carries `console:<change id>`, which says both
  where a row came from and which change caused it, and
  `console/changes.jsonl` records every change, refusals included.
- **Several claims.** Spec 016 lets more than one claim run, so `current` is
  a list. Direction A's one large card goes to the oldest claim; the rest
  are compact rows, which keeps the decided layout for the usual case of
  one slot.
- **Server-side sessions** in the table, so there is no signing secret to
  generate, store or rotate, and logout really ends a session.
- **Telegram link.** The questions log holds Telegram message ids, but a
  private bot chat has no web link to a message, so the console links to
  the chat with the bot; the GitHub question and reply comments are the
  permanent record and are always linked.
- **Cost.** CloudFront, S3, Lambda, API Gateway and DynamoDB at one user's
  traffic sit in or near the free tiers; the held change poll (about 3,000
  requests a day, each reading the table every 2 seconds) is the largest
  line. The reservation states 2 USD a month so the ledger holds the console
  to it, and while the cap is 0 the deploy is refused, as it should be.

## 5. Interfaces and files

- `console/` (workspace package `@panelator/console`, toolchain from the
  `catalog:` of `pnpm-workspace.yaml`, spec 029 AC-6): `src/` (the app,
  Feature-Sliced Design, TanStack Router and Query, Tailwind with the tokens
  of `specs/051-console/design/`), `api/` (handlers of AC-5 and AC-6:
  `auth.ts`, `state.ts`, `changes.ts`, `table.ts`, `lambda.ts`),
  `infra/stack.yaml` (AC-7), `test/`, `package.json`, `tsconfig.json`,
  `vite.config.ts`, `vitest.config.ts`.
- `schemas/scheduler/console-state.json`, `console-change.json` (AC-2,
  AC-4).
- `tools/scheduler/src/console/`: `state.ts` (AC-2), `push.ts` (AC-3),
  `poll.ts` and `apply.ts` (AC-4), `deploy.ts` (AC-7, calling `aws/cli.ts`
  and `aws/ledger.ts`). `tools/scheduler/src/service/loop.ts`: the push
  step and the poller's lifetime. `tools/scheduler/src/config.ts`: the
  `console` block (AC-1). `tools/scheduler/src/state/paths.ts`:
  `console/changes.jsonl`. `tools/scheduler/src/actions/undo.ts`: an
  optional `run_id` for `undoAction` (AC-4). `tools/scheduler/src/telegram/poller.ts`:
  keep the connected username for `telegram_url` (AC-2).
  `tools/scheduler/bin/scheduler.ts`: `console state`, `console deploy`,
  `console destroy`.
- `tools/scheduler/test/`: `console.test.ts` (snapshot with and without each
  source, push and debounce, poll and apply of each kind, refusal, the same
  id twice applied once, mode change not in the action log, key never
  logged, deploy refused with AWS off and at cap 0), `config.test.ts`,
  `loop.test.ts`, recorded runs in `e2e.test.ts`. `tools/README.md`: the
  block and the commands.
- `pnpm-workspace.yaml`: `console` added to `packages`.
- `agents/scheduler.yaml`: the `console` block, added only after a
  successful deploy (section 6).

No file outside `console/`, `tools/`, `agents/scheduler.yaml`,
`schemas/scheduler/`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and
`dev-logs/` is changed by the implementation. `tools/scheduler/`, `agents/`,
`pnpm-workspace.yaml` and `console/vitest.config.ts` (`**/vitest.config.*`)
are sensitive paths, so the security review runs on the PR as spec 006 AC-9
says.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including: the recorded chains unchanged with no `console` block; a tick
  pushing a snapshot and a second tick inside `push_min_s` with no change
  pushing nothing; a pulled `set_parameter` applied as `maintainer` with
  `run_id` `console:<id>` and its outcome posted; the same id twice applied
  once; a `set_parameter_mode` recorded in the parameter history and absent
  from the action log; an `undo`, a `pause_agent` and a refused unknown
  kind; a deploy refused with AWS off and at cap 0; API handler tests for
  sign-in by the configured login, 403 for another and for a bad `state`,
  cookie and key never interchangeable, long-poll returning at once on a
  new change and empty after `wait`.
- The console's Vitest suite covers each screen's states of section 7
  against fixture snapshots; the stories in `specs/051-console/design/`
  render at the three viewports with spec 029's renderer and the PR shows
  them.
- With section 9 done and spec 022's `aws-check` passing, the implement
  stage runs `console deploy`, signs in, adds the `console` block, and
  writes up in `dev-logs/` the URL, the first pushed snapshot and a
  parameter change round trip. Otherwise the PR states that the console is
  built and untested in the cloud and is not deployed elsewhere.

## 7. UI design

Screens: home, questions, history, actions, agents, parameters

Flow: sign-in leads to Home; a bottom tab bar on mobile and a side rail on
tablet and desktop reach the other five; the Home banner opens Questions, a
current card opens its issue's PR, each tile opens History at its metric
(the AWS tile at Parameters' `aws_cap_usd`). States per screen: loading,
stale, API unreachable, signed out, empty (no questions, idle system, no
actions yet, no metrics report), and for Parameters, Actions and Agents a
pending change and a refused change. Interaction notes and the component
mapping are written by the design stage into `design/flow.md`; the rendered
artifacts (stories, `tokens.html`, three renders per screen) live in
`design/` beside this spec and are produced by spec 029's renderer.

## 8. Open decisions

None.

## 9. Setup the maintainer does (the capabilities this spec needs)

Four things are the maintainer's alone (design section 3, item 3). The
implement stage raises them as `capability` questions through the question
check when it reaches the deploy step of section 6 and cannot proceed, one
question carrying all that is still missing, with these steps copied in.
Until then it builds against the fakes.

**1. A cap that covers the console.** `aws_cap_usd` is locked and 0, so
every reservation is refused (spec 050). Raise it to at least the console's
2 USD a month plus whatever else is reserved: `panelator-scheduler param set
aws_cap_usd <usd>`.

**2. Extra permissions for the pipeline.** Add to the `PanelatorDelivery`
permission set's inline policy (spec 022 section 8, step 2) the actions the
stack needs: `cloudformation:*` on stacks named `panelator-console*`;
`s3:*` on buckets named `panelator-console-*`; `cloudfront:*`; `lambda:*`,
`apigateway:*`, `dynamodb:*` and `logs:*` on resources named
`panelator-console*`; `iam:CreateRole`, `iam:PutRolePolicy`,
`iam:PassRole`, `iam:GetRole`, `iam:DeleteRole`, `iam:DeleteRolePolicy` on
roles named `panelator-console*`; and, with a domain, `route53:*` on the
zone and `acm:*`. Then `aws sso login --sso-session default`.

**3. The GitHub OAuth app.** GitHub, Settings, Developer settings, OAuth
Apps, New OAuth App: name `panelator console`, homepage the console URL
(the CloudFront URL printed by a first deploy, or the domain), callback
`<url>/auth/callback`. Store the client secret where only the account can
read it: `aws ssm put-parameter --name /panelator/console/github_client_secret
--type SecureString --value <secret> --profile panelator-delivery`. Reply
with the client id; it goes into `agents/scheduler.yaml` as
`console.github_client_id`. Given no domain, the first deploy runs without
sign-in configured and prints the URL, so the callback can be registered;
the second deploy enables sign-in.

**4. A domain, if wanted.** Reply with the name; the stack adds a Route 53
hosted zone and an ACM certificate (about 0.50 USD a month for the zone,
added to the reservation), and the maintainer points the registrar's name
servers at the zone. Given "no domain", the CloudFront URL is the console's
address.
