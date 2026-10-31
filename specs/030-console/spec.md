# 030. The maintainer console

Status: written 2026-11-01 from the design-stage-and-console design (spec E,
part 2) for the console issue filed from that design; specs derived from the
design need no maintainer approval (delivery-system design section 11). Needs
specs 029 and 022 on `main`; its `design/` is produced by spec 029's design
stage before implementation.
Class: tooling. Domain: web-ui.
Parent: docs/designs/design-stage-console.md
Derives from: [design stage and console design](../../docs/designs/design-stage-console.md)
sections 2 and 3; [ADR 0005](../../docs/decisions/0005-console-static-site-small-api.md)
(static site, small API, long-poll pull); [delivery-system design](../../docs/delivery-system-design.md)
sections 3 ("What happens while it waits": questions listed on the console),
6.2 (console exposure), 8 ("AWS for the delivery system") and 9 ("The
console"); [charter](../../docs/charter.md) (a secure, hosted, mobile-friendly
interface; parameters set to auto or locked; the UI kept up to date);
[design-tree](../../docs/design-tree.md) R5.Q4 (toolchain);
[spec 008](../008-agent-registry/spec.md) (parameters, actions, undo, pause);
[spec 022](../022-delivery-aws-account/spec.md) AC-6 (`reserveSpend`) and
section 8 (the pattern for setup only the maintainer can do);
[spec 027](../027-metrics/spec.md) AC-5 (the metrics report);
[spec 007](../007-telegram-channel/spec.md) (the questions log's Telegram
fields and the long-poll pattern); [spec 006](../006-no-human-stops/spec.md)
AC-18 (the questions log).

What the maintainer decided (design section 9 and issue #38), kept as it is
here: home screen direction A; every screen designed and reviewed at mobile,
tablet and desktop; parameters each with an auto or locked switch; sign-in
only for the maintainer's GitHub login; nothing connects in to the laptop,
the scheduler pushes state and pulls changes; a delivery-system package
separate from `web/` reusing its React toolchain; hosted in the delivery
account against its cap. Creating the GitHub OAuth app and choosing a domain
are the maintainer's alone (section 8).

## 1. Goal

Give the maintainer the charter's interface: from a phone, tablet or laptop,
signed in with GitHub, see what the system is doing now, what it asks, how it
has performed over time, what it did on its own, and set or lock its
parameters. Six screens in a `console/` package, hosted as ADR 0005 says, fed
by a state snapshot the scheduler pushes at every tick and steering the
scheduler through changes it pulls and applies as the `maintainer` actor
through spec 008's one path. Everything the console shows comes from the
snapshot, and the snapshot carries lists, so a new agent, parameter or metric
appears without a console change.

## 2. Out of scope

- The look of the screens: spec 029's design stage decides it in
  `specs/030-console/design/`, within direction A and this spec's section 7.
- Hosting anywhere but the delivery account. Given AWS off (spec 022 AC-2) or
  a refused reservation, the stage builds and tests, deploys nothing, and
  says so in its PR; the issue's `blocked` label (design section 3) keeps
  this from being reached before spec 022 merges.
- Intake, grilling or answering questions from the console: a question is
  answered on Telegram (spec 007); the console links to the thread.
- Any access for anyone but the maintainer's login; no roles, no read-only
  guests.
- Changing the parameter store, the lock rule, the action kinds or the
  questions log; the console calls what spec 008 provides.
- Writing to the laptop from the cloud: no webhook, port or SSH; the API
  only answers the scheduler's requests.
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review.

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API and a fake `aws`
command, as in specs 001 and 022; the API is exercised in tests through its
handler functions with an in-memory table, and the app through Vitest with
Testing Library and Storybook stories. *Snapshot* is the `console-state`
document of AC-2. *Change* is a `console-change` document of AC-4.

**The scheduler side**

- AC-1. **Configured, or absent.** `agents/scheduler.yaml` gains a `console`
  block: `url` (the API base), `credentials_path` (default
  `~/.config/panelator/console.json`, holding the scheduler's API key written
  by the deploy of AC-7, never in the repository or a log), `push_min_s`
  (default 30), `long_poll_s` (default 50, max 300). Given the block is
  absent, then the console is off, logged once, and every behaviour of
  earlier specs is unchanged (the recorded chains of specs 006, 007, 008,
  013, 022 and 026 pass unchanged). A test asserts the key appears in no log
  line, run record or stage environment.
- AC-2. **The snapshot.** `buildConsoleState(ctx)` in
  `tools/scheduler/src/console/state.ts` returns `console-state`
  (`schemas/scheduler/console-state.json`): `generated_at`;
  `questions: [{ id, issue, kind, text, options, asked_at, status: open |
  reminded | answered, answered_at?, telegram_url?, decision_url? }]` from
  the questions log; `current: { issue, title, stage, stages: [{ name,
  status: done | running | pending | failed }], model, started_at,
  elapsed_s, cost_usd, pr? } | null` from the active claim and its run
  records (stages in the order plan, implement, verify, review, fix, merge,
  with the spec and design tracks shown as a stage named for the track);
  `up_next: [{ issue, title, class }]` from the shortlist's next picks;
  `tiles: { merged_per_week, median_issue_to_merge_h, rework, aws: {
  actual_usd, forecast_usd, cap_usd } }` from the latest metrics report and
  `aws/cost.json` (null fields when a source is absent); `metrics` the
  latest `metrics-report` (spec 027 AC-5, replaced metrics included);
  `actions` the last 200 entries of the action log with their `undo` and
  status; `agents: [{ name, last_run, next_run, cost_30d_usd, paused,
  paused_by }]` from the registry; `parameters: [{ name, type, value, mode,
  min?, max?, description, changed_at, changed_by }]`; `pending_changes`
  the changes received and not yet applied. Given a source file is missing,
  then its field is null or empty and the snapshot is still valid.
- AC-3. **Push on change, at least every tick.** Given the console on, then
  the tick (after spec 022's pull step) builds the snapshot and, given it
  differs from the last pushed one or `push_min_s` has passed, `PUT`s it to
  `<url>/state` with the API key; a question asked, answered or reminded, a
  claim change, an action applied and a parameter change each trigger a
  push outside the tick, debounced to one per `push_min_s`. Given the push
  fails, then it is logged once per change of state and retried at the next
  tick; nothing else waits on it. `panelator-scheduler console state` prints
  the snapshot (the laptop fallback of design section 8).
- AC-4. **Changes are pulled over a held connection and applied through spec
  008.** Given the console on, then the service holds a long-poll `GET
  <url>/changes?after=<cursor>&wait=<long_poll_s>` open at all times, as
  spec 007's poller does for Telegram, reconnecting on return or error with
  backoff; nothing listens on the laptop. Each change `{ id, at, by, kind,
  args }` with `by` the signed-in login is applied at once: `set_parameter`
  through `setParameter(name, value, "maintainer")`; `set_parameter_mode`
  through `setParameterMode(name, mode, "maintainer")`; `undo` through the
  action log's undo; `pause_agent` and `resume_agent` through their action
  kinds with actor `maintainer`. Each is logged in the action log with
  `by: maintainer`, `via: console`, `change_id`; a refusal (range, unknown
  name, unknown kind) is logged with its reason. The outcome is `POST`ed to
  `<url>/changes/<id>/result` and a push follows, so the console shows the
  result within seconds. Given the same `id` arrives twice, then it is
  applied once.

**The hosted side**

- AC-5. **Sign-in for one login.** `GET /auth/login` starts GitHub OAuth with
  the app of section 8; the callback exchanges the code, reads the login,
  and given it equals the configured maintainer login, sets a signed,
  `HttpOnly`, `Secure`, `SameSite=Lax` session cookie valid 30 days; given
  any other login, it returns 403 with no cookie and records the attempt.
  Every other route except the static assets and `/auth/*` requires a valid
  session (browser) or the scheduler's API key (`PUT /state`, `GET
  /changes`, `POST /changes/<id>/result`); the key never works for browser
  routes and the cookie never for scheduler routes. `POST /auth/logout`
  clears the session.
- AC-6. **The API.** One DynamoDB table holds the latest snapshot, the change
  queue and sessions. `GET /state` returns the latest snapshot and its age;
  `POST /changes` (session) appends a change with a new id and returns it;
  `GET /changes?after&wait` (key) returns new changes at once or holds up to
  `wait` seconds (capped at the platform limit, 29 seconds behind API
  Gateway, so the scheduler's `long_poll_s` is a reconnect cadence, not a
  promise); `POST /changes/<id>/result` (key) stores the outcome. Handlers
  are plain functions in `console/api/` tested with an in-memory table; the
  Lambda entry points wrap them.
- AC-7. **Deployed by the scheduler, inside the cap.** `console/infra/stack.yaml`
  is one CloudFormation stack (S3 bucket, CloudFront distribution, HTTP API,
  Lambda functions, the table, their IAM role, and with a domain the
  Route 53 records and ACM certificate). `panelator-scheduler console
  deploy` first calls `reserveSpend` with `what: "maintainer console
  (CloudFront, Lambda, DynamoDB)"`, the stated monthly cost (computed from
  the stack's resources, expected under 2 USD a month at this traffic) and
  `why` naming the charter's interface requirement; given it is refused or
  AWS is off, then nothing is deployed and the command exits non-zero with
  the reason. Given it is reserved, then it runs `aws cloudformation deploy`
  through spec 022's `cli.ts`, builds the app, syncs it to the bucket,
  invalidates the distribution, writes the generated API key to
  `credentials_path` and prints the console URL. The maintainer login
  and the OAuth client id are stack parameters; the client secret is read
  from a parameter the maintainer created (section 8) and never passed on a
  command line. `panelator-scheduler console destroy` releases the
  reservation after deleting the stack.

**The screens**

- AC-8. **Home (direction A).** Given a signed-in maintainer on any viewport,
  then Home shows: a banner with the count of open questions linking to
  Questions, absent when there are none; one large card for `current`
  (issue, title, the stage progress with the running stage marked, model,
  elapsed, cost so far, link to the PR) or "idle" with the next tick time;
  "up next" with the first three of `up_next`; four stat tiles, merged per
  week, median issue-to-merge, rework, AWS spend against the cap (actual,
  forecast and cap, with the cap 0 shown as "no cap set"). On tablet and
  desktop the extra width is laid out as the design decides.
- AC-9. **Questions.** Open first, then answered, each with its issue, kind,
  text, options, when asked, status, a link to the Telegram thread when
  `telegram_url` is present and to the decision record when answered.
- AC-10. **History.** Every metric of the report over its weekly buckets as
  a chart, with the window selectable (4, 12, 26, 52 weeks); a replaced
  metric is drawn beside its replacement for as long as the report carries
  both; a null bucket is a gap, not a zero.
- AC-11. **Actions.** The action log newest first, each with what, why,
  which agent, when, status, and an **Undo** control when `undo` is not null
  and the entry is `applied`; pressing it posts an `undo` change and shows
  the entry as pending until the result arrives.
- AC-12. **Agents.** Each standing agent with last run, next run, cost over
  30 days and a **Pause** or **Resume** control posting the change; an agent
  paused by the maintainer says so.
- AC-13. **Parameters.** Each parameter with its description, value, limits
  and an **auto / locked** switch; a value edit posts `set_parameter`, the
  switch posts `set_parameter_mode`; a locked parameter shows that the
  system cannot change it; a pending change is shown until its result
  arrives and a refusal shows its reason.
- AC-14. **Freshness and failure are visible.** Every screen shows the
  snapshot's age; older than three ticks it is marked stale. Given the API
  unreachable, then the app says so and keeps the last snapshot it had.

## 4. Design notes (agent's calls)

- **Lists, not fields, in the snapshot.** Design 6.2 wants the console to
  keep up with the system. A console that renders lists of parameters,
  agents, metrics and actions needs no change when one is added.
- **Pull, not push, for changes,** because the design says nothing connects
  in to the laptop. The 29-second API Gateway cap on a held request makes
  "held open" a reconnect loop, which is what the Telegram poller already is.
- **The maintainer actor is the console's only actor.** Sign-in admits one
  login, and every change it makes is applied as `maintainer`, so the lock
  rule of spec 008 is exactly the charter's: locked means the system cannot
  change it, the maintainer can.
- **Cost.** CloudFront, Lambda, API Gateway and DynamoDB at one user's
  traffic sit in or near the free tiers; the reservation states the figure
  so the ledger holds the console to it.

## 5. Interfaces and files

- `console/` (workspace package `@panelator/console`, toolchain from the
  catalog of spec 029 AC-6): `src/` (the app, Feature-Sliced Design as the
  product's web app will be, TanStack Router and Query, Tailwind with the
  tokens of `specs/030-console/design/`), `api/` (handlers of AC-5 and
  AC-6, `auth.ts`, `state.ts`, `changes.ts`, `table.ts`), `infra/stack.yaml`
  (AC-7), `test/`, `package.json`, `vitest.config.ts`.
- `schemas/scheduler/console-state.json`, `console-change.json` (AC-2, AC-4).
- `tools/scheduler/src/console/`: `state.ts` (AC-2), `push.ts` (AC-3),
  `poll.ts` (AC-4), `deploy.ts` (AC-7, calling `aws/cli.ts` and
  `aws/ledger.ts`). `tools/scheduler/src/service/loop.ts`: the push step and
  the poller's lifetime. `tools/scheduler/src/config.ts` and
  `agents/scheduler.yaml`: the `console` block (AC-1).
  `tools/scheduler/src/actions/log.ts`: the `via` and `change_id` fields
  (AC-4). `tools/scheduler/bin/scheduler.ts`: `console state`, `console
  deploy`, `console destroy`.
- `tools/scheduler/test/`: `console.test.ts` (snapshot, push, poll and
  apply, idempotent change, key never logged, deploy refused with AWS off),
  `loop.test.ts`, recorded runs in `e2e.test.ts`. `tools/README.md`: the
  block and the commands.

No file outside `console/`, `tools/`, `agents/`, `schemas/scheduler/`,
`package.json`, `pnpm-workspace.yaml` and `dev-logs/` is changed by the
implementation. `tools/scheduler/`, `agents/`, `package.json` and
`pnpm-workspace.yaml` are sensitive paths, so the security review runs on
the PR as spec 006 AC-9 says.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including: the recorded chains unchanged with no `console` block; a tick
  pushing a snapshot and a second tick inside `push_min_s` with no change
  pushing nothing; a pulled `set_parameter` applied as `maintainer` and its
  result posted, the same id twice applied once, a `set_parameter_mode` and
  an `undo`; a deploy refused with AWS off; API handler tests for sign-in by
  the configured login, 403 for another, cookie and key never
  interchangeable, long-poll returning on a new change.
- The app's Vitest suite covers each screen's states against fixture
  snapshots; the stories in `specs/030-console/design/` render at the three
  viewports with spec 029's renderer and the PR shows them.
- With section 8 done and spec 022's `aws-check` passing, the implement
  stage runs `console deploy` and signs in; the URL, the first pushed
  snapshot and a parameter change round trip are written up in `dev-logs/`.
  With `aws-check` failing, the PR states that the console is built and
  untested in the cloud and is not deployed elsewhere.

## 7. UI design

Screens: home, questions, history, actions, agents, parameters

Flow: sign-in leads to Home; a bottom tab bar on mobile and a side rail on
tablet and desktop reach the other five; the Home banner opens Questions, the
current card opens the issue's PR, each tile opens History at its metric.
States per screen: loading, stale, API unreachable, empty (no questions, idle
system, no actions yet), and for Parameters, Actions and Agents a pending
change and a refused change. Interaction notes and the component mapping are
written by the design stage into `design/flow.md`; the rendered artifacts
(stories, `tokens.html`, three renders per screen) live in `design/` beside
this spec and are produced by spec 029's renderer.

## 8. Open decisions

None.

## 9. Setup the maintainer does (the capabilities this spec needs)

Three things are the maintainer's alone (design section 3, item 3). The
implement stage raises them as `capability` questions through the question
check when it reaches the deploy step of section 6 and cannot proceed, in
this order, one question carrying all that is still missing, with these steps
copied in. Until then it builds against the fakes.

**1. Extra permissions for the pipeline.** Add to the `PanelatorDelivery`
permission set's inline policy (spec 022 section 8, step 2) the actions the
stack needs: `cloudformation:*` on stacks named `panelator-console*`;
`s3:*` on buckets named `panelator-console-*`; `cloudfront:*`;
`lambda:*`, `apigateway:*`, `dynamodb:*` and `logs:*` on resources named
`panelator-console*`; `iam:CreateRole`, `iam:PutRolePolicy`,
`iam:PassRole`, `iam:DeleteRole`, `iam:DeleteRolePolicy` on roles named
`panelator-console*`; `ssm:GetParameter` on `/panelator/console/*`; and,
with a domain, `route53:*` on the zone and `acm:*`. Then `aws sso login
--sso-session default`.

**2. The GitHub OAuth app.** GitHub, Settings, Developer settings, OAuth
Apps, New OAuth App: name `panelator console`, homepage the console URL
(the CloudFront URL printed by a first deploy, or the domain), callback
`<url>/auth/callback`. Store the client secret where only the account can
read it: `aws ssm put-parameter --name /panelator/console/github_client_secret
--type SecureString --value <secret> --profile panelator-delivery`. Reply
with the client id; it goes into `agents/scheduler.yaml` as
`console.github_client_id` (it is not a secret). Given no domain, the first
deploy runs without sign-in configured and prints the URL, so the callback
can be registered; the second deploy enables sign-in.

**3. A domain, if wanted.** Reply with the name; the stack adds a Route 53
hosted zone and an ACM certificate (about 0.50 USD a month for the zone),
and the maintainer points the registrar's name servers at the zone. Given
"no domain", the CloudFront URL is the console's address.
