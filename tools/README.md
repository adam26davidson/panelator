Workspace packages for automation and CI scripts. One directory per tool.

- `design-stage/`: the design package of spec 029 (the charter's "design-specific tools"). `pnpm -F @panelator/design-stage storybook` serves a Storybook of every `specs/*/design/*.stories.tsx` with Tailwind and the base tokens of `src/tokens.css`. `pnpm -F @panelator/design-stage render <spec dir> [--screen <name>]` builds that Storybook, opens each named screen's stories with Playwright at `mobile` 390x844, `tablet` 820x1180 and `desktop` 1440x900 (device scale 2) and writes `<screen>.png` (desktop), `<screen>.mobile.png`, `<screen>.tablet.png` and `<screen>--<state>.png` with their siblings beside the stories. It is the only way renders are made: each PNG carries a `panelator-render` tEXt chunk (viewport, story id, commit), and the design review rejects one without it. The toolchain versions live in the `catalog:` of `pnpm-workspace.yaml`, so `console/` and `web/` reuse them with one bump; `pnpm -F @panelator/design-stage lint` runs Biome and knip over the package, and CI runs it after the scheduler typecheck. Chromium comes from `@playwright/browser-chromium`, whose install script is approved in `allowBuilds`. `pnpm test` builds and renders a fixture spec in a temporary directory, so a toolchain break fails CI.
- `scheduler/`: the deterministic scheduler of spec 001. `pnpm -F @panelator/scheduler typecheck` for types; tests run from the root `pnpm test`.
  Install the service: `mkdir -p ~/.config/systemd/user && ln -sf "$PWD/tools/scheduler/systemd/panelator-scheduler.service" ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now panelator-scheduler`. Logs: `~/.local/state/panelator-scheduler/log/service.jsonl` and `journalctl --user -u panelator-scheduler`. Self-update exits 75 so `Restart=on-failure` restarts it.
  While any chain stage or standing agent runs, the service holds a `systemd-inhibit --what=sleep:idle --mode=block` lock (`systemd.inhibit` in `agents/scheduler.yaml`); between runs, including a chain waiting on a quota reset, the laptop may still suspend. The service log records `inhibit-acquired`, `inhibit-released` and, once, `inhibit-unavailable`.

## Operating the scheduler

Run the service from a dedicated clone of the repository, checked out on `main` with an https `origin`, not from a development checkout. The scheduler fast-forwards that checkout before every poll and restarts itself when `tools/scheduler/` or `agents/` changes, and stages push through a credential helper that only works over https. The unit's `WorkingDirectory` points at `~/Projects/panelator`; adjust it if the clone lives elsewhere. Node 26 must be first on the unit's `PATH`, since the scheduler runs its TypeScript directly.

The scheduler acts as a GitHub App installed on the repository with the permissions of spec section 12: issues, pull requests and contents (write), checks and actions (read), metadata (read), plus repository security advisories (write) once the filing agent (design spec C) lands. Set `app.id`, `app.installation_id`, `app.private_key_path` and `app.bot_login` in `agents/scheduler.yaml`; `repo`, `maintainer`, `slots`, `poll_interval_s`, `required_checks` and `state_dir` live in the same file. A missing App id, an unreadable private key, a checkout that is not on `main` or an origin that is not https makes the scheduler log a `config-error` record and exit 78, which the unit does not restart.

These labels must exist in the repository: `validated`, `in-progress`, `needs-decision`, `abandoned`, `blocked`, `priority`, `class:product`, `class:bug`, `class:tooling`, `class:dependency`, and the reflection labels `reflection`, `reflection:delivery`, `reflection:charter` and `reflection:meta` (GitHub creates a label on its first use; the scheduler does not create labels). `needs-design-stage` may still exist in the repository but no code path applies it any more (spec 029): once per issue, the scheduler removes it from an issue parked with it and comments that the design stage now exists. The old `needs-spec`, `needs-design`, `needs-clarification`, `needs-human` and `security-review` labels are no longer applied (spec 006). Enable branch protection on `main` requiring the `test` check, so a PR the scheduler merges has passed CI.

The first run is `node tools/scheduler/bin/scheduler.ts --check-auth`, which prints the bot login and token expiry, then `--once`, which runs one tick and waits for the chains it started. Only then enable the service.

Security findings go to the fix loop and nothing waits for a human to clear a label; see spec 006 (`specs/006-no-human-stops/spec.md`) for the escalation path, the question flow and the labels.

## The design stage

A `web-ui` or `widget` spec on `main` without its design artifacts (three renders per named screen and a story or token prototype) starts the `design` stage (`agents/stages/design.md`, strong tier) instead of parking the issue. It runs on branch `design-<issue>`, writes Storybook stories under `specs/NNN-<slug>/design/` and renders them with the package above, and opens a design PR whose body starts with `Refs #<issue>`. The PR's scope is that `design/` directory and nothing else. It is reviewed under the `design` profile (`agents/profiles/design/`: the visual criteria in `review-criteria.md`) by an independent reviewer, goes through the fix loop on the design stage's model, and merges. The gate is then checked on `main`: if it still fails, the design stage runs again, up to `bounds.design_revisions` in `agents/scheduler.yaml` (default 2), after which the spec agent revises the UI design section. When the gate passes, the chain plans the implementation.

## Planned children of a design

On the service's first tick and on every tick where `origin/main` moved, the scheduler runs `fileDesignChildren` (`tools/scheduler/src/children/`) over the designs on `main`. For each `- planned: <slug>` bullet in a design's `## Children` section that has no issue, it files one issue authored by the App, labelled with the child's class and `validated`, whose body is the brief, a link to the design and the marker `<!-- panelator-child:<design>:<slug> -->`. A child whose `after:` siblings are not done is also labelled `blocked`, with a comment carrying `<!-- panelator-child-blocked:<design>:<slug> -->`; when they are done the scan removes `blocked` and comments with `<!-- panelator-child-unblocked:<design>:<slug> -->`. A design's planned children are filed in dependency order (a sibling named by `after:` first, bullet order otherwise). When the App put `blocked` on the scan's own child issue and the blocked comment never arrived (it failed after the issue was filed), the scan reads the label timeline, posts the missing comment and then judges unblocking as usual (spec 078). Only issues and comments authored by the App count, and a `blocked` the scan did not add is never removed. An `issue: #<n>` on the bullet records an existing issue and nothing is filed for it. The scan logs `child-filed`, `child-blocked-comment-posted`, `child-unblocked`, `child-issue-dead`, `child-after-unknown`, `child-filing-failed` and `children-scan-failed` to the service log. The only state file is `children/failures.json` in the state directory, the count of consecutive scans on which an issue could not be filed; the third failure appends one finding and resets the count. See spec 031.

## Standing agents, actions and parameters

`agents/standing/<name>.md` is a standing agent: YAML frontmatter declares a schedule
(minimum `1h`) and/or event subscriptions, harness/model, bounds, schemas, read-only or
fresh worktree, profile and allowed action kinds. The body is its prompt. Files are
validated at startup; adding/removing one through a reviewed PR reloads the registry
at the next drained self-update. The shipped agents are `findings-filer` (daily plus
queue/abandonment events) and `action-audit` (weekly). They share the configured slots
with issue chains, after answered questions and before new issue claims.

Local commands run as the service user, using the same config/state directory. They do
not require the service checkout to be on main or App authentication (except workflow
undo, which needs the App). Use `node tools/scheduler/bin/scheduler.ts` followed by:

- `agent list`, `agent pause <name>`, `agent resume <name>`, `agent run <name>`.
- `action list [--since <ISO time>]`, `action undo <id>`.
- `contacts list` prints the approved parties (`contacts/parties.json`; `[]` when none) and `contacts remove <party>` removes one and writes a `removed` line to the contacts log (spec 099 AC-9). First contact on GitHub is enforced by the App installation's scope, not by the `gh` shim (ADR 0014): the scope check (`GET /app/installations`, `GET /installation/repositories`) runs at start-up, in `--check-auth` (which prints `installation scope ok` or the reason it failed) and in the credential check's pre-run.
- `credentials: [<name>, ...]` in a profile's `profile.yaml` or a standing definition's front matter lists the catalogue entries a run may use; the run gets `<run dir>/bin/<command>` shims first on `PATH`, each running `tools/scheduler/bin/cred-exec.ts <name> -- <command> [args]` (a separate entry point that loads only the configuration, the catalogue and the store, and writes nothing). `wrapper.command` is a bare name matching `^[a-z][a-z0-9._-]*$`.
- The scheduler emits `credential_expiry` (hourly step, at most once per credential per day, from the index only) and the `credential-check` standing agent (daily, or on that event) renews what `renew.command` can renew (`renew_credential`) and warns about the rest; every notification also reaches the Telegram chat (`channel` in the service log says which carried it), and a reply to one gets "Alerts take no reply".
- `contacts log [--since <ISO time>]` (the first-contact gate's log: refused calls and removed parties; writes nothing).
- `param list`, `param set <name> <value>`, `param mode <name> auto|locked` (prints the parameter's new state; recorded in the parameter history).

Numbers and booleans use JSON syntax; durations use `1h`, `12h`, `7d`, etc. Only the
maintainer commands may change a parameter's mode or resume a maintainer-paused agent.
`system_work_share` replaces the fixed feature/debt ratio; `slots` is read every tick.
`schedule.<agent>` parameters preserve their values and locks across registry changes.

`agents/actions.yaml` sets levels. Level 1 requests are checked and logged before their
effect; level 2 requests are refused and queued as findings for a reviewed PR. The log
is `actions/log.jsonl`, parameter history is `parameters/history.jsonl`, agent state is
`agents/<name>.json`, and filer decisions/cursor are `findings/triage.jsonl` and
`findings/cursor.json` under the state directory. A startup marks interrupted pending
actions failed rather than replaying external side effects. Workflow re-run and cancel
require **actions:write** on the App; with actions:read their 403 is logged as failed.
Security findings are routed to draft repository advisories, never public issues.

Wiping the state directory forgets every claim but leaves their `in-progress` labels on GitHub; remove those by hand, or the issues are never picked up again.

The shipped profiles are `backend`, `design`, `security` and `spec`. A plan whose domain names any other profile fails, and the firmware HIL check of spec section 8 has no owner until the firmware profile spec.

## Credentials (specs 030 and 069)

- The `credentials` block of `agents/scheduler.yaml` (both keys optional): `dir`
  (default `~/.config/panelator/credentials`, created `0700` by the first `cred set`) and
  `warn_days` (default 7, at least 1; read and validated, used by the expiry producer when it is built).
  Each secret is a `systemd-creds` blob `<dir>/<name>.cred`; `<dir>/index.json` holds names, dates and
  check results, never a secret. `PANELATOR_SYSTEMD_CREDS` overrides the `systemd-creds` path (a test hook
  for the fake under `test/helpers/`).
- `agents/credentials.yaml` is the catalogue. `check` has two forms: a command run through the entry's
  wrapper (exit 0 means it works; reported `skipped: wrapper not built` until the shims exist), or
  `{ builtin: github-app | telegram-get-me }` for a `wrapper: none` entry, a probe the scheduler runs over the
  stored secret. `github-app` signs an App JWT with the stored key and calls `GET /app`; it passes only when
  GitHub answers with the configured `app.id`, and it mints no installation token.
- `panelator-scheduler cred set <name>` reads the secret from stdin, stores it, then runs the check. Exit 0:
  the stored secret works. Exit 1: it was stored but failed its check (the reason and the setup steps are
  printed), so run it again with the right secret. `cred list` (set or missing, last check),
  `cred check [<name>]` (exit 1 when any check failed), `cred import` (stores `app.private_key_path` and
  `telegram.credentials_path`) and `cred remove <name>`.
- Each of those but `cred list` is a row in the action log, kind `cred_set`, `cred_check`, `cred_import` or
  `cred_remove`, `agent: maintainer`, `args: { name }`, one row per credential.
- The scheduler reads the App key from the store once `github-app-key` is set, else from `app.private_key_path`.

## The delivery-system AWS account (spec 022)

The scheduler talks to one AWS account of its own, through the `aws` CLI only (`--profile`, `--region`, never an SDK).
Add the block to `agents/scheduler.yaml` once the account and its profile exist; without it AWS is off and the service
behaves as before.

```yaml
aws:
  profile: panelator-delivery   # AWS CLI profile (default)
  account_id: "123456789012"    # twelve digits, required
  region: us-east-2             # default
  pull_interval_h: 24           # default, minimum 6
```

- The identity (`sts get-caller-identity`) is checked at start and before each pull; another account or a failure turns
  AWS off with one `aws-access` notification.
- Once per `pull_interval_h` the tick pulls the month-to-date cost (`ce get-cost-and-usage`, about one cent) into
  `aws/cost.json` and an `aws.cost` event, and judges the forecast against `aws_cap_usd`. While the cap is 0 only the
  identity is checked.
- Code that creates a billable resource calls `reserveSpend` (`src/aws/ledger.ts`) first; a refusal is an `aws-funds`
  notification and a `maintainer.contact` event of kind `funds`.
- `panelator-scheduler aws-check` runs the identity check and the cost call and prints the SSO expiry (exit 0 only when
  both pass; at cap 0 no cost call is made). `panelator-scheduler aws [--json]` prints the cost record and the
  reservations. `panelator-scheduler aws pull` forces a pull, even at cap 0.

### The `aws-sso` credential, `aws_scale` and the funds request (spec 068)

- `agents/credentials.yaml` has the entry `aws-sso` (`provider: aws`): the secret is the profile name of the `aws`
  block (`panelator-scheduler cred set aws-sso`, then `cred check aws-sso`). Every `aws` call for it goes through
  `src/aws/cli.ts` with `--profile <the secret>`, `--region` and `--output json`: the check (`sts get-caller-identity`,
  ok only for the configured `account_id`) and `cred exec aws-sso -- aws <args>` (the shim infra health's `aws` takes;
  `--profile`, `--region` and `--output` are refused, the output is the parsed JSON). Without an `aws` block the check
  is `skipped` ("aws: off") and nothing warns.
- `panelator-scheduler aws sso-expiry [--profile <name>]` prints the time a login is needed by, read from the AWS CLI's
  cache (`~/.aws/sso/cache/<sha1 of the session name>.json`; `AWS_CONFIG_FILE` and `AWS_SSO_CACHE_DIR` override the paths
  for tests): for an `sso_session` profile whose cache holds a refresh token, the cached `registrationExpiresAt` (the CLI
  renews the access token itself until then, so `expiresAt` says nothing about a login); otherwise `expiresAt`. It prints
  `none` for a profile that is not SSO, or exits 1 with a reason. Only those two times and the presence of a refresh token
  are read, never a token. `cred set`, `cred check` and the credential check's pre-run write the time into the credential
  index. For a renewable session the `credential-expiry` message is one heads-up per distinct time, not a daily ask; a
  failed identity check warns daily.
- The entry's `renew_steps` are what the maintainer gets in the `credential-expiry` message once the credential is set
  up: 1. `aws sso login --sso-session default`; 2. `panelator-scheduler cred check aws-sso`; 3. `aws-check` if it still
  fails.
- `aws_scale` (level 1; infra health and `action undo`) moves a ledger reservation between the two states its launcher
  wrote in the reservation's `scale` descriptor (`lambda-concurrency`, `cloudfront-distribution`,
  `dynamodb-throughput`), within the cap; infra health uses it on an `aws_forecast_over_cap` alarm.
- A refused reservation is a funds request: the `aws-funds` message lists `Amount`, `Purpose` and `Charter goal`, then the two
  steps that raise the cap (`param set aws_cap_usd <cap + shortfall>` and the budget amount in the management account),
  and is recorded once as a `maintainer.contact` event of kind `funds` with the request.

The six policy actions `aws_scale` needs, beside spec 022's `sts:GetCallerIdentity` and `ce:GetCostAndUsage`, are added
to the `PanelatorDelivery` permission set's inline policy on resources whose names start `panelator-`; nothing under
`budgets:`, `organizations:` or `iam:` is asked for:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution",
        "dynamodb:DescribeTable",
        "dynamodb:UpdateTable"
      ],
      "Resource": [
        "arn:aws:lambda:*:*:function:panelator-*",
        "arn:aws:cloudfront::*:distribution/*",
        "arn:aws:dynamodb:*:*:table/panelator-*"
      ]
    }
  ]
}
```

(CloudFront distribution ARNs carry no name, so that one statement resource is the account's distributions.)

## The maintainer console (spec 051)

A static site, a small API and a CloudFormation stack in the delivery account (`console/`), fed by a snapshot the scheduler
pushes and steering the scheduler through changes it pulls. Nothing connects in to the laptop. Without a `console` block the
console is off (logged once at start) and nothing else changes.

```yaml
console:
  url: https://dxxxx.cloudfront.net   # the API base: the console's own URL
  credentials_path: ~/.config/panelator/console.json   # {"api_key": "..."}, mode 0600, written by `console deploy`
  github_client_id: Iv1.abc           # not a secret; the OAuth app of spec 051 section 9
  push_min_s: 30                      # at least 5: the debounce of event pushes and the longest gap between pushes
  long_poll_s: 25                     # 1 to 28: how long one change poll is held before it reconnects
```

An unknown key is a config error. The maintainer login is the top-level `maintainer`.

- `panelator-scheduler console state` prints the snapshot (`console-state`) as the console would receive it.
- `panelator-scheduler console deploy [--client-id <id>] [--domain <name> --hosted-zone <id>]` reserves 2 USD a month with
  `reserveSpend` (refused at cap 0, over the cap or with AWS off: nothing is deployed and the command exits non-zero), deploys
  `console/infra/stack.yaml`, uploads the function and the app, invalidates CloudFront and writes the API key to
  `credentials_path`. A second deploy keeps the reservation and the key. The GitHub client secret is read by the sign-in
  function from the SSM parameter `/panelator/console/github_client_secret`; it never appears on a command line.
- `panelator-scheduler console destroy` deletes the stack, then releases the reservation. It fails with the reservation kept unless `describe-stacks` answers or says the stack does not exist.
- A domain needs the configured aws region `us-east-1` (CloudFront takes certificates only from there, and the console is one stack); `console deploy --domain` refuses before reserving otherwise.

Changes made on the console are applied as the `maintainer` actor through the same paths as `param set`, `param mode` and
`agent pause|resume`; an action row's `run_id` is `console:<change id>` and every change with its outcome is recorded in
`console/changes.jsonl` in the state directory.

## Events (spec 026)

The scheduler appends every run, stage transition, merge, CI result, review, finding, action, question, pause,
slot sample, notification, parameter change, issue it files and standing-agent run as one JSON line to
`events/<YYYY-MM>.jsonl` in its state directory, through `recordEvent`; the backfill's `recordBackfillEvent` is the
only other writer. Nothing rewrites or deletes those files. `events/index.sqlite` is a derived `node:sqlite` index,
rebuilt from the JSONL whenever it is missing or unreadable and reloaded when it carries an older schema version;
every connection waits up to 30 seconds for a lock, because the service and the laptop commands open the same file.
A line that fails to parse is skipped and reported once in the service log.

- `panelator-scheduler events backfill` records the older records (`usage/`, `merges.jsonl`, the action, question,
  finding and parameter logs) as events, once. A second run records nothing. A record whose shape fails its payload
  schema is kept as it is and counted as `old_shape`. The service runs it at its first start after this code lands
  (`events/backfilled.json` holds the time and counts).

## Metrics (spec 027)

A metric is `agents/metrics/<name>.yaml`: `name` (the file name), `goal` (`speed`, `delivery`, `quality`, `spend` or
`autonomy`), `description`, `unit`, `direction` (`lower` or `higher` is better), `introduced`, `rationale` (at least 200
characters: the decision it drives and why it tracks the goal), `query`, and optionally `replaces` and `retired`. The
query is one read-only `SELECT` (or `WITH ... SELECT`) over the `events` table only, taking `:from` and `:to` and
returning `(bucket, value, n)` per ISO week (the bucket is the week's Monday, `YYYY-MM-DD`). A bad definition fails the
registry test and exits the service with 78. A definition with `replaces: <old>` keeps `<old>` computed and present for
28 days after its `introduced` date, and its rationale must differ from the old one's. Changes go through a reviewed PR.

- `panelator-scheduler metrics [--weeks <n>] [--json] [--snapshot] [--all]` prints the last `n` weeks (default 12) as a
  table or JSON; `--all` includes retired metrics; `--snapshot` records the report as a `metrics.snapshot` event.
- `panelator-scheduler metrics show <name>` prints one definition and its history from the earliest event in the index.
- `panelator-scheduler events query "<sql>"` runs one read-only `SELECT` against the index and prints the rows as JSON.

## Reflection agents and plan issues (spec 028)

Three standing agents in `agents/standing/` mirror the delivery system: `delivery-reflection` (weekly, or after ten
merges: `trigger.min_events: 10`) looks for bottlenecks, metric trends and design-tree gaps; `charter-reflection`
(weekly) judges the system against each charter clause and reviews every maintainer contact, filing one item per
recurring kind; `meta-reflection` (monthly) judges the metrics and the reflections themselves. `min_events` is an
optional integer (at least 1, default 1) on a trigger that has `events`: the agent is due on events only once that
many are pending (a due schedule, or the retry after a first failure, still runs it with what is pending).

The scheduler builds each agent's input (`tools/scheduler/src/reflection/input.ts`, validated against
`schemas/scheduler/reflection-input.json`) for the period from the agent's last successful run (28 days back on the
first run), and records that run's `metrics.snapshot`. Before the first attempt for a period it writes
`reflection: {period_from, plan_key}` into the agent's state record; every retry, and a rerun after the process died,
reuses it, and it is cleared only when an attempt succeeds. The agent has read-only tools and no GitHub tool.

A **plan issue** is the record of a plan: an issue the App creates, titled `<Agent> plan <date>`, labelled
`reflection` and `reflection:<delivery|charter|meta>`, never `validated`, so the shortlist ignores it. Its body carries
the summary, observations, metrics note, the open questions (built from the events, never from the agent's note), the
items with links, the direct actions applied and the deferred items, and ends with
`<!-- panelator-reflection:<plan key>:plan -->`. The plan is also written to `reflections/<agent>/<plan key>.json`.
Each item becomes a `validated` issue authored by the App (class label, `Plan: #<plan>` first line, any `Spec:` line
removed, ending `<!-- panelator-reflection:<plan key>:<index> -->`); an item pointing at an `existing_issue` gets one
comment linking the plan instead. At most `reflection_max_issues` (`agents/scheduler.yaml`, default 8) items are filed
per plan, counting those a crashed attempt already filed; the rest are listed as deferred ("over the plan bound"), as
are items with an unknown class, a body under 200 characters, or a `metric_change` without a `## Rationale`. The
previous plan issue of the same agent (the `plan_issue` of its latest `reflection.plan` event) is closed with a link
to the new one, only when it is open and authored by the App.
