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
Revised 2026-11-21 to answer the plan stage's ten questions: section 1 ("What
`main` has, and what is left") and the paragraphs marked *(agent's call)*. The
revision adds four marks: spec 030 AC-2 again and
[099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-12 (an entry's optional `renew_steps`), spec 099 AC-2 (`cred-exec.ts` and
`runCheck` for a `provider: aws` entry), and
[028-reflection-agents](../028-reflection-agents/spec.md) AC-5
(`open_questions` reads a request's send).
Revised 2026-11-22 after the first build's reviews and the maintainer's two
replies on issue #130 (questions #7071686442 and #7076977958): AC-2 (which
cached time says a login is needed), AC-7 (a change of the forecast's state
re-arms its notice, in `src/aws/cost.ts`), AC-9 (the permission set carries
the six actions; when to ask again), AC-10 (the service's own notifier
windows, `queued`), and sections 1, 5 and 6. It adds two marks:
[022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-3 (the
expiry line) and AC-9 (the notice's re-arm).
Revised 2026-11-22 again after the second review: AC-2's heads-up paragraph
says where `renewable` and `heads_up_for` are kept and that the skip is the
scheduler's, and section 5 lists the files; it adds marks on spec 030 AC-1 and
AC-5 and spec 099 AC-3, and widens the spec 099 AC-12 mark.
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

**What `main` has, and what is left** *(agent's call, answering the plan
stage; read from `main` at 8cebdd3, and again at 98893c8 on 2026-11-22)*. Specs 022, 026, 030 (through specs 069
and 099), 050 and 064 are implemented on `main`, so nothing blocks this build
and the issue needs no `blocked` label. Part of this spec landed with them (PR
#365 and spec 099's implementation). For a criterion listed as built, the
implement stage changes no code: it checks that the named test exists and
passes, and adds the test when it is missing.

- **Built.** AC-1's catalogue entry with its eight `access` actions
  (`agents/credentials.yaml`; `credentials.test.ts` loads it). AC-4 whole:
  `notify` resolving to `{ channel }`, `suppressed` from the rate limiter, the
  wiring order in `bin/scheduler.ts`, the recorder writing `contact.kind` and
  `request` (`notify.test.ts`). AC-5 whole: the funds text and the `contact`
  field in `src/aws/ledger.ts` (`aws.test.ts`). AC-9's list in the entry.
- **To build.** AC-1's `provider: aws` path for the check and for `cred
  exec`. AC-2: `src/aws/sso.ts`, the `aws sso-expiry` command, the expiry
  written to the index, `renew_steps`, and which cached time it reads. AC-3: both request events, `outcome` on
  the event schema, the reflection reader. AC-6, AC-7 and AC-8 whole. AC-9's
  `tools/README.md` text (its capability question is answered, AC-9). AC-7's
  re-arm of the forecast notice in `src/aws/cost.ts`. AC-10's recorded runs.

*(agent's call, 2026-11-22)*
[102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md)'s
implementation is on `main` at 98893c8: a send the chat could not take is
`queued`, and `Notifier.clear` exists (its AC-6). AC-4, AC-7 and AC-10 are
written for that base. A first build of this spec's earlier text is the head
of the closed PR #424 (`refs/pull/424/head`, b20ac67); the implement stage may
take from it what still fits, and what this revision changes (AC-2's time,
AC-7's re-arm, AC-10's notifier windows) is built to this text. `main`
changes `tools/README.md`, `tools/scheduler/bin/scheduler.ts`,
`tools/scheduler/test/helpers/fake-aws` and the infra health input often;
the build starts from `main`'s head and keeps its edits to them small.

## 2. Out of scope

- Everything spec 030 builds (the store, the shims, the request object, the
  gate, the `TelegramNotifier`, the two standing agents' GitHub-side halves)
  and everything spec 022 builds (the account, the pull, the forecast, the
  ledger's `reserveSpend` and `releaseSpend`, the thresholds, the alarm, the
  commands). This spec adds to them and changes none of their rules, except
  the ones section 4 marks: spec 030 AC-1 (`heads_up_for` and `renewable` in
  the index record), spec 030 AC-5 and spec 099 AC-3 (the producer skips a
  renewable credential already warned for) and spec 099 AC-12 (once per
  distinct `expires_at` for a renewable session).
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
  is repository content), `cred list` shows it missing, its check is skipped
  with the reason "aws: off" gives below and nothing calls `aws`; the recorded chains of earlier specs
  run unchanged.

  *(agent's call)* **How the check runs.** `runCheck`
  (`src/credentials/check.ts`) gains a branch for an entry with `provider:
  aws`, taken before the "wrapper not built" result. `CheckContext` gains
  `aws?: { config?: AwsConfig; cli: (profile: string) => AwsCli; env:
  NodeJS.ProcessEnv }`, built in `bin/scheduler.ts` from the `aws` block
  (`cli` is `awsCli({ profile, region: config.region })`). In order: no
  `aws.config` gives `{ status: "skipped", reason: "aws: off: no aws block in
  agents/scheduler.yaml" }` and reads nothing; a secret that cannot be read
  gives `failed` with the store's reason, which names `cred set aws-sso`; the
  secret, trimmed, is the profile name, and one that does not match
  `^[A-Za-z0-9_.-]+$` gives `failed` with "not a profile name"; otherwise `sts
  get-caller-identity` runs through `aws.cli(<the profile>)`, and the result
  is `ok` when `Account` equals `account_id`, else `failed` with spec 022
  AC-2's reason or the CLI error's first line. This check does not touch
  `AwsContext.state` and sends no `aws-access` notification; spec 022 AC-2's
  own identity check does that. After the identity call, whatever its result,
  `runCheck` calls `ssoExpiry(<the profile>, aws.env)` in process (AC-2) and
  writes the index: `{ expires_at }` through `store.writeExpiry`, `{ none }`
  sets `expires_at` to null (`writeExpiry` accepts null), `{ error }` leaves
  the index as it is and does not change the check's result. `cred set`, `cred
  check`, a "Done" answer (spec 099 AC-5) and the credential check's pre-run
  (spec 099 AC-12) all call `runCheck`, so all four refresh the expiry.
  Nothing spawns the entry's `expiry.probe` string: it names the command a
  person runs, and `renew_credential`'s probe runner is not reached for a
  `renew: manual` entry. Every other string check (the test catalogue's
  `fakecmd --check`) stays `skipped` with "wrapper not built": no entry on
  `main` needs one, and the general command check is not this issue's.

  *(agent's call)* **Skipped, not failed, without an `aws` block.** A
  deployment with no `aws` block does not use the credential, so its check is
  `skipped`: `cred check aws-sso` prints `aws-sso: check skipped: aws: off: no
  aws block in agents/scheduler.yaml` and exits 0, `last_check` stays null, no
  `credential_expiry` event is produced, and the credential check's agent,
  which warns only for a failed check or a near expiry, does not warn. With an
  `aws` block and the credential not set, the check is `failed` and the daily
  warning carries the `setup` steps: AWS is in use and the last setup steps
  were not done.

  *(agent's call)* **`cred exec` for this entry.** The code is
  `bin/cred-exec.ts` (spec 099 AC-2), not `src/credentials/commands.ts`; it is
  the path infra health's `aws` shim takes. It gains a branch for `provider:
  aws`. The first word after `--` must be `aws`, the wrapper's command
  (anything else exits 1 with "cred-exec: aws-sso wraps aws only"), and is
  dropped. An argument `--profile`, `--region` or `--output`, bare or with
  `=`, exits 1 with "cred-exec: --profile, --region and --output are set by
  the scheduler". With no `aws` block it exits 1 with "cred-exec: aws: off".
  Otherwise it finds `aws` on `PATH` with the shim directory removed, as it
  finds any command today, and calls `awsCli({ profile: <the secret, trimmed>,
  region: <the block's> }, { command: <that path>, env: <the environment
  without the shim directory> }).run(<the remaining args>)`. On success it
  prints the parsed value as `JSON.stringify(value, null, 2)` on stdout and
  exits 0; on failure it prints the error's message, which `cli.ts` has
  already redacted and cut, on stderr and exits 1. Stdin is not passed, the
  timeout is `cli.ts`'s, and `AWS_PROFILE` is set in no child environment for
  this entry.
- AC-2. **The expiry comes from the CLI's cache, and the token is never
  read.** `panelator-scheduler aws sso-expiry [--profile <name>]` (default:
  `AWS_PROFILE`, else the `aws` block's `profile`) prints the time a login
  is needed by ("Which cached time", below) as ISO time, or the word `none` when the profile is not an SSO
  profile, or exits 1 with a reason when the profile or its cache file is
  missing. It reads the profile stanza from `~/.aws/config`: with
  `sso_session = <name>`, the cache file is `~/.aws/sso/cache/<sha1 hex of
  the session name>.json`; with the legacy `sso_start_url`, `<sha1 hex of
  the start URL>.json` (how the AWS CLI names them). Of that file only
  `expiresAt`, `registrationExpiresAt` and whether a `refreshToken` key is
  present are read; `accessToken`, the refresh token's value, `clientSecret`
  and every other field are never read into a variable, logged, printed or recorded, asserted by a
  test over the service log, the command's output and the index after a
  probe. The same function (`ssoExpiry(profile, env)` in
  `tools/scheduler/src/aws/sso.ts`) serves `aws-check`'s expiry line of spec
  022 AC-3, so there is one reader. Given the credential check's daily run or
  a `credential_expiry` event (spec 030 AC-5, produced from the probe's
  `expires_at` in the index), then the credential check (spec 030 AC-13)
  carries `aws-sso` in its `warnings` when the session ends within
  `warn_days` or the last check failed, and the scheduler sends one
  `credential-expiry` notification with the entry's `renew_steps` (below; the
  login step first), once per day, over Telegram when it is on (spec 030 AC-9).
  Spec 022 AC-2's `aws-access` notification on an identity failure is
  unchanged and separate: it says AWS went off, the warning says how to log
  in again.

  *(agent's call)* **The reader's shape.** `ssoExpiry(profile: string, env:
  NodeJS.ProcessEnv = process.env): { expires_at: string } | { none: true } |
  { error: string }` moves from `src/aws/check.ts` to `src/aws/sso.ts`
  together with `profileStanza`; `check.ts` keeps no copy. The config file is
  `env.AWS_CONFIG_FILE` when set, else `<home>/.aws/config`; the cache
  directory is `env.AWS_SSO_CACHE_DIR` when set, else `<home>/.aws/sso/cache`;
  `<home>` is `env.HOME`, else `os.homedir()`; each of the two paths is
  resolved on its own. (`AWS_SSO_CACHE_DIR` is this scheduler's variable, for
  tests; the AWS CLI does not read it.) Results: a config file that cannot be
  read, or no stanza for the profile, is `{ error: "no profile <name> in
  <config path>" }`; a stanza with neither `sso_session` nor `sso_start_url`
  is `{ none: true }`; no cache file, or one that does not parse, is `{ error:
  "no cached SSO token found (run aws sso login)" }`; a file without
  `expiresAt`, or with one `Date.parse` rejects, is `{ error: "no expiresAt in
  the cached token" }`; otherwise `{ expires_at: <the string as cached> }`
  (for a session the CLI renews itself, the next paragraph replaces these
  last two results). The file is parsed and only the three things AC-2 names
  are taken from the parsed value, which is not kept, passed on or logged; that is what "never read into a
  variable" means above. `aws sso-expiry` prints `expires_at`, or `none`, or
  the error on stderr with exit 1, and needs no `aws` block when `--profile`
  or `AWS_PROFILE` names the profile. `aws-check`'s line keeps its words: `sso
  session expires: ` followed by `expires_at` as cached, `not SSO` for `none`,
  or the error's text. The one case that changes is a missing config file or
  stanza, which printed `not SSO` and now prints the error. `awsCheck(ctx,
  home?)` becomes `awsCheck(ctx, env?)`, and `aws.test.ts`'s fixtures pass `{
  HOME: <dir> }`. The index stores `new Date(expires_at).toISOString()`.

  *(agent's call, 2026-11-22)* **Which cached time says a login is needed.**
  The cached `expiresAt` is the access token's, about an hour after the CLI
  last fetched one. For a profile with `sso_session` the cache also holds a
  refresh token, and the CLI fetches a new access token by itself on its next
  call (the AWS CLI's `botocore/tokens.py`, `_refresher` and
  `_refresh_access_token`: inside 15 minutes of `expiresAt` it refreshes, and
  it cannot once `registrationExpiresAt` has passed). For such a session
  `expiresAt` is always inside `warn_days` and says nothing about a login:
  the first build read 2026-11-22T08:33:30Z an hour after the maintainer had
  logged in, a login was asked for that was not needed, and the daily warning
  would have fired every day. The maintainer's reply: "The current `aws
  sso-expiry` implementation reads the cached access token's `expiresAt`. The
  CLI can refresh that token automatically while the shared SSO session is
  active, so that timestamp alone is insufficient evidence that someone needs
  to sign in." (maintainer answer, question #7076977958)

  So `ssoExpiry`'s first result becomes `{ expires_at: string; renewable:
  boolean }`. A session is *renewable* when its stanza has `sso_session` and
  its cache file has a `refreshToken` key (the key's presence is tested, its
  value never taken) and a `registrationExpiresAt` that `Date.parse` accepts.
  For a renewable session `expires_at` is `registrationExpiresAt` as cached,
  the last moment the CLI can renew the token and so the time a login is
  certainly needed by, and `expiresAt` is not required: missing, unparsable
  or in the past, it is no error. For every other session (the legacy
  `sso_start_url`, or a cache file without a refresh token) `expires_at` is
  `expiresAt` as the paragraph above says, with `renewable: false`; there it
  is the session's end. The portal session's own end (an IAM Identity Center
  setting; the entry's first `setup` step sets it to 90 days) is in no local
  file. When it comes before the registration's, the next identity call
  fails, and that is the check's part: `runCheck` makes the identity call
  first (AC-1), which is also what makes the CLI renew the token, the failed
  check puts `aws-sso` in the daily warning with the `renew_steps`, and spec
  022 AC-2 sends `aws-access`. The warning is therefore early where the date
  can be known and at the first failed check where it cannot. `aws
  sso-expiry` prints `expires_at` and nothing else. `aws-check`'s line is
  `sso session expires: <expires_at>`, followed for a renewable session by
  ` (login needed by; the CLI renews the access token until then)`. Tests:
  a renewable fixture whose `expiresAt` is an hour past and whose
  `registrationExpiresAt` is sixty days ahead gives that later time and no
  `credential_expiry` event or warning; the same with the registration three
  days ahead gives the warning once (the paragraph after next); a legacy fixture gives its `expiresAt`; the
  never-read assertion plants marker strings as `accessToken`, `refreshToken`
  and `clientSecret` and finds none of them in the service log, the
  command's output, `aws-check`'s output or the index.

  *(agent's call, 2026-11-22)* **A renewable session's notice is one heads-up,
  not a daily ask.** Read from the AWS CLI's own source
  (`awscli/botocore/utils.py`, `SSOTokenFetcher._registration`): `aws sso
  login` reuses the cached client registration until it is within 15 minutes
  of its own `expiresAt`, and copies that registration's `expiresAt` into the
  new token file as `registrationExpiresAt`. So a login inside `warn_days` of
  `registrationExpiresAt` does not move it: logging in early changes nothing,
  and only a login in the last 15 minutes, or after it has passed, makes a
  new registration. The notice must therefore not ask for a login and then
  repeat. For a renewable session (`renewable: true`) inside `warn_days`,
  the scheduler sends one `credential-expiry` notification, once for each
  distinct `expires_at`, not once a day. *Where the flag is kept.* `runCheck`
  writes `renewable` (boolean, from `ssoExpiry`) to the credential's index
  record beside `expires_at`, and the index records the time warned for as
  `heads_up_for` (an optional ISO string, written when the notification is
  sent); both are optional fields of `IndexEntry`
  (`src/credentials/store.ts`) and of `schemas/scheduler/credential-index.json`,
  and a `{ none }` or `{ error }` result leaves `renewable` as it is or, for
  `none`, removes it. *Who skips.* The skip is the scheduler's, made in two
  places and nowhere in the agent: the `credential_expiry` producer
  (`expiryEvents` in `src/credentials/check.ts`, spec 030 AC-5, which reads the
  index alone) emits no event for an entry that is `renewable`, whose
  `heads_up_for` equals its `expires_at` and whose last check passed; and
  `notifyCredential` in `src/standing/run.ts`, where a result's warnings become
  notifications, sends nothing for such an entry. The credential check's own
  input, schema and prompt (`credential-check-input.ts`,
  `credential-check-input.json`, `agents/standing/credential-check.md`) are
  unchanged, so on day two the agent may still list `aws-sso` in `warnings`;
  the scheduler discards it for that entry and the notification, not the
  agent's list, is what the maintainer sees. For any other warning (a
  non-renewable credential, a renewable one not yet warned for this
  `expires_at`, a failed last check) `notifyCredential` sends as today, daily,
  and for a renewable entry first writes `heads_up_for` through
  `store.writeHeadsUp(name, expires_at)`. The heads-up text states the date
  ("the CLI's login registration ends <expires_at>; no action is needed before
  then, the CLI renews the access token by itself; log in again on or after
  that date, or when a check fails") and carries the `renew_steps` as the
  steps for that day. A failed check (the portal session ended first, or the
  profile is wrong) is not renewable-specific: it warns daily with the
  `renew_steps` as spec 030 AC-13 says, whatever `heads_up_for` holds. A
  non-renewable session (legacy, or no refresh token) is unchanged: it warns
  daily inside `warn_days`, and a login there does move `expiresAt`. Tests
  (`credentials.test.ts` for the index and the producer, `standing.test.ts` for
  the notification): with the renewable fixture three days ahead, day one
  gives one `credential_expiry` event, one warning in the scripted result and
  one notification, and `heads_up_for` equal to `expires_at`; the fixture is
  then rewritten as a login would leave it (a new access token and `expiresAt`,
  the same `registrationExpiresAt`), `cred check aws-sso` prints `check ok`,
  and the next day's hourly step gives no event and a scripted result that
  still carries the `aws-sso` warning gives no notification; a fixture whose
  registration has changed to a later time gives none either while it is
  outside `warn_days`, and one inside it warns once more for the new
  `expires_at`; a failing identity check on the second day warns once with the
  `renew_steps`.

  *(agent's call)* **The login step comes from the catalogue.** A catalogue
  entry may carry an optional `renew_steps`, a list of at least one string:
  what the maintainer does to renew a credential that is already set up
  (`schemas/scheduler/credential-catalogue.json`, `CredentialEntry`).
  `aws-sso`'s is, in order: run `aws sso login --sso-session default`; run
  `panelator-scheduler cred check aws-sso`, which prints `check ok`
  when the identity call passes and records the cached time; if the check still fails, `panelator-scheduler
  aws-check` says why, and the full setup is in `agents/credentials.yaml`.
  Where `src/standing/run.ts` builds a `credential-expiry` notification for a
  warning, the steps are the entry's `renew_steps` when it has them and the
  credential is set in the index, else its `setup` as today. The order is
  therefore the scheduler's, read from the catalogue, and a recorded run
  asserts it whatever steps the scripted result carries.
  `agents/standing/credential-check.md` and the check's input are unchanged
  (the heads-up's skip above is the scheduler's, not the agent's).

**Events for every contact** (design section 7; spec 026 AC-2; spec 030
section 2, second bullet)

- AC-3. **A request's send and answer are one event each.** Given a question
  carrying a `request` (spec 030 AC-6) is sent (spec 007 AC-5, spec 030
  AC-7), then the `maintainer.contact` event spec 026 AC-2 records for the
  `sent` entry has `kind` equal to `request.type` (`credential`, `funds` or
  `first_contact`) instead of `question`, `label: "request"`, `text` the
  question's own text as spec 026 records it today (the question sentence the
  driver passes; the request's fields are in `payload.request`, not
  re-rendered into `text`), and `payload.request` the request object as sent; one
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
  `sent` contact) and for the
  answer as the next paragraph says.

  *(agent's call)* **One writer for both events.** `appendQuestionLog` in
  `src/state/questions.ts` records both. For a `sent` entry that carries
  `request`, the contact it already records has `kind: request.type`, `label:
  "request"` and `request`; a `sent` entry without one, and every `reminded`
  entry, is recorded as today. For an `answered` entry that carries `request`,
  it records the answer event: `channel` the entry's (`issue` when absent),
  `kind: request.type`, `label: "answer"`, `text` the entry's `answer`,
  `request`, `outcome` the entry's, with `issue` and `question_comment_id`. An
  `answered` entry without a request records no contact, as today. The two
  call sites in `src/service/loop.ts` (`#resume` and `#answerCapability`)
  already pass `request`, `outcome`, `channel` and the answer that
  `applyRequestAnswer` (`src/chain/driver.ts`) returned, and they write the
  entry only when the question has no answered entry yet, so the event is
  recorded once per question. Neither they, nor `src/chain/question.ts`, nor
  `src/contacts/approve.ts` (which only writes `contacts/parties.json`)
  changes. `text` is whichever answer the stage receives, including spec 099
  AC-5's two, `done (not checked: <reason>)` and `done (unverified: <name> is
  not in the catalogue)`, both with `outcome: text`, and a first contact's
  approval text with `outcome: approved`. `schemas/scheduler/event.json` gains
  `outcome` on the payload here, and `request`, an untyped object on `main`,
  gains its required `type` enum.

  *(agent's call)* **Reflection still finds the question's text.**
  `openQuestions` in `src/reflection/input.ts` (spec 028 AC-5) takes each open
  question's text from the `maintainer.contact` event of its send. Its
  selection becomes: payload `kind` `question`, or payload `kind` one of
  `credential`, `funds`, `first_contact` with payload `label` `request`;
  matched by issue and `question_comment_id` as today. The `label` test keeps
  the answer event, which shares the kind and the comment id, from being taken
  for the question. `groupContacts` needs nothing: it groups by `kind` and
  `label`, whatever they are. `reflection.test.ts` gains a sent credential
  request that is still open and asserts its question text (the sentence
  the send event carries) in `open_questions`.
- AC-4. Amended by [102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md) AC-2: `channel` is also `queued` when the Telegram notifier held the notice for the channel's return. **A notification's event names the channel that carried it.**
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

  *(agent's call)* Built on `main` (section 1). Spec 102's implementation is
  on `main` too (98893c8), so a send that failed, or Telegram off, gives
  `queued`, as the mark above says, and `main`'s `notify.test.ts` asserts
  that; this spec's build changes neither.

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

  *(agent's call)* Built on `main` (section 1); the text there also has a
  `Refused: <reason>` line after `Asked by`, which stays. The event's
  `channel` is whatever `notify` returned (AC-4): this criterion fixes the
  kind, the request and that there is one event, not the channel.

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

  *(agent's call)* **The event and the wiring.** The `aws.reserve` payload in
  `schemas/scheduler/event.json` gains `scaled` in its `outcome` enum and an
  optional `direction` (`up` or `down`); the scaled event carries the
  reservation's `id`, `what`, `why` and `by`, the `expected_monthly_usd` now
  in force, `outcome: "scaled"` and `direction`. `ActionContext`
  (`src/actions/index.ts`) gains `aws?: AwsContext`, set to the one
  `AwsContext` that `bin/scheduler.ts` builds, in the service's action context
  (so the `applyAction` calls of `src/standing/run.ts` carry it) and in the
  `action` command's. `aws_scale`'s `check` refuses with "aws: off" when it is
  absent or has no `config`, and with "aws: off: <reason>" when `ensureOn`
  (spec 022 AC-2) is false. `aws_scale` returns its `undo` from `apply`, as
  `ActionKind.apply` allows; `applyAction` computes none for it.

  *(agent's call, 2026-11-22)* **The recovery notice is not held back.** The
  over-cap notice and the recovery notice are one identity (`0:aws:aws-forecast`),
  and `aws` is a lasting gate (spec 102 AC-5), so the rate limiter would
  suppress a recovery that follows the over-cap notice within
  `notify_repeat_hours` (24 by default): the maintainer would be told the
  forecast is over the cap and never that infra health brought it back, which
  is what the first build's review found. `judge` (`src/aws/cost.ts`), which
  both a pull and a ledger change go through, therefore calls
  `ctx.notifier.clear?.({ issue: 0, gate: "aws", label: "aws-forecast" })`
  (spec 102 AC-6's re-arm) before it sends the notice of a change of state:
  from not over to over, and from over to not over. The repeat it sends while
  the forecast stays over (after 24 hours) calls no clear. A clear that
  throws is written to the service log and the notice is still sent. Nothing
  else in `judge` changes: the alarm, the texts, `notices.json` and the other
  labels are as spec 022 AC-9 left them. `aws.test.ts` asserts it through a
  `rateLimited` notifier with the configuration's default windows (`notify_rate_limit_hours` 4 and
  `notify_repeat_hours` 24, as `config.ts` and `agents/scheduler.yaml` have
  them): over the cap, then a scale down inside the window, gives two delivered `aws-forecast`
  notices, the over-cap one and the recovery, and a further `judge` with no
  change of state sends nothing.
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

  *(agent's call)* **Where `on` comes from.** `buildInfraHealthInput`'s deps
  gain `aws?: AwsContext`, passed by `src/standing/run.ts` from the service's
  deps (`src/service/loop.ts` holds it as `aws`). With no context or no
  `config`, the value is the "no aws block" one above and nothing is called.
  Otherwise, when the identity has not been checked in this process
  (`state.identityAt` is null), the builder calls `ensureOn` first, as
  `panelator-scheduler aws` and `reserveSpend` do: one free `sts` call through
  `src/aws/cli.ts`, so the first run after a restart sees the true state, not
  a false "off". Then `on` is `state.on === true`, `off_reason` is
  `state.reason` when off, `cap_usd` is `readCap`, and `cost` and
  `reservations` come from `readCost` and `readLedger` (`src/aws/book.ts`).
  `infra-health-input.test.ts` covers the three states: no block, off with a
  reason, on.
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

  *(agent's call)* The entry's list is on `main` (section 1); the
  `tools/README.md` text is what is left of this criterion to build.

  *(agent's call, 2026-11-22)* **The question has been asked and answered.**
  The first build raised this criterion's capability question, and the
  maintainer replied: "PanelatorDelivery now carries the six aws_scale actions
  from tools/README.md (on panelator-* Lambda/DynamoDB and the account's
  CloudFront distributions), provisioned to 849692148420 and verified from the
  delivery role (DescribeTable allowed on panelator-*, denied outside the
  prefix). The SSO session is live and `cred set aws-sso` stored
  `panelator-delivery`." (maintainer answer, question #7071686442) So the
  implement stage does not raise it again, and the missing question is not a
  finding against its PR. The policy JSON in `tools/README.md` is the one that
  reply describes: the Lambda and DynamoDB statements on resources named
  `panelator-*`, and the CloudFront statement on the delivery account's
  distributions, because a distribution's ARN carries an id and no name; that
  is what "resources whose names start `panelator-`" above means for
  CloudFront. A stage asks the maintainer again only on a live refusal, and
  quotes the `aws` error's first line in the question: a `credential` request
  for a login when `cred check aws-sso` fails and the error says the session
  or token has expired or a login is needed; one for the permission set when
  a call is denied (`AccessDenied`) for an action of this list. The printed
  time of `aws sso-expiry` is never by itself the reason to ask (AC-2).
- AC-10. **Live cases end to end.** Recorded worlds (`e2e.test.ts`,
  `helpers/e2e-routes.ts`; the fake `aws`, Telegram, `systemd-creds` and the
  fixture home) drive and assert, *(agent's call, 2026-11-22)* each world
  with the notifier chain of `bin/scheduler.ts` and the configuration's
  default `notify_rate_limit_hours` and `notify_repeat_hours`, never with a
  window set to 0, so a run asserts what the service sends; two cases that
  would share a notification identity inside a window run in separate
  worlds:
  - `cred set aws-sso` with a profile whose renewable fixture cache file
    (AC-2) has `registrationExpiresAt` three days ahead and `expiresAt` an
    hour past: the probe writes the registration's time as `expires_at` to
    the index without reading a token, the hourly step emits `credential_expiry` once, the
    credential check returns one `aws-sso` warning, one `credential-expiry`
    message reaches the fake Telegram with the login step first (from
    `renew_steps`, whatever steps the scripted result carries), logged with
    `channel: telegram`, and nothing twice: after a login that leaves the same registration, the next day gives no event, warning or notification (AC-1, AC-2);
  - the same with the fake identity returning another account: the check
    fails, `aws-access` is sent once (spec 022 AC-2), and the credential check warns once with the `renew_steps`, the credential
    being set (AC-1, AC-2);
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
    Telegram refusing: still one event with `kind: funds`, whose `channel`
    equals the `channel` of the service log line for that send and is
    `queued` *(agent's call, 2026-11-22: spec 102's implementation is on
    `main`, section 1)* (AC-4, AC-5);
  - no `aws` block: `cred check aws-sso` prints `check skipped` and exits
    0, the credential check's input has `checks["aws-sso"].status`
    `skipped`, and no `credential_expiry` event or `credential-expiry`
    notification names `aws-sso`; with a block and the credential not set,
    the check fails and one warning carries the `setup` steps (AC-1);
  - a ledger with reservation A (`scale` of kind `lambda-concurrency`, up 6
    USD, down 1 USD) and reservation B (8 USD, no descriptor), a cap of 10
    USD, the clock on the 15th day of a 30-day month and a pull whose
    actual is 4 USD. Spec 022 AC-5's forecast, unchanged, gives for that
    fixture: reserved 14 USD, trend 4 / 15 x 30 = 8 USD, ledger view 4 + 14
    x 15 / 30 = 11 USD, so `forecast_usd` 11 USD, over the cap.
    `infra_alarm` of kind `aws_forecast_over_cap` wakes infra health, whose
    scripted result requests `aws_scale` down for A; the fake `aws` records
    one `put-function-concurrency` call; the ledger shows A `down` at 1
    USD, `reserved_usd` 9 USD and `forecast_usd` equal to the forecast
    recomputed with A at 1 USD (ledger view 4 + 9 x 15 / 30 = 8.5 USD,
    trend 8 USD, so 8.5 USD), which is at or below the cap, so one
    `aws-forecast` recovery notification is sent and reaches the fake
    Telegram after the over-cap one, two `aws-forecast` messages in that
    order inside the same hour (AC-7's re-arm); one `aws.reserve` event
    `outcome: scaled`, the action log `applied` with an `undo` of direction
    `up`; the agent's finding names B as "cannot scale: no descriptor".
    The saving of 5 USD lowers the forecast by 2.5 USD, not 5: the ledger
    view counts a reservation only over the days left in the month, and
    the trend does not move. The figures are what spec 022 AC-5's formula
    gives for the fixture; where a figure here and the formula disagree,
    the formula governs and the test asserts the relation (AC-6 to AC-8);
  - the next sweep with the cap raised to 20 USD, at the same clock date
    and with the same pulled actual of 4 USD: the scripted result requests
    `up` for A, the forecast ends at the value recomputed with A at 6 USD
    (11 USD again, at or below the new cap), A is `up` at 6 USD; a request
    for `up` again is refused "already up"; a request for a released
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
- Spec 030 AC-2, a second mark: `Amended by ... AC-2: an entry may carry an
  optional renew_steps list, the steps that renew a credential already set
  up.`
- Spec 099 AC-2: `Amended by ... AC-1: for a provider: aws entry,
  cred-exec.ts runs the call through src/aws/cli.ts with the stored profile
  and prints its JSON, and runCheck runs that entry's check and reads its
  expiry.`
- Spec 099 AC-12: `Amended by ... AC-2: the notification carries the entry's
  renew_steps when it has them and the credential is set, else its setup
  steps, and for a renewable credential it is sent once per distinct
  expires_at, not once a day.`
- Spec 030 AC-1: `Amended by ... AC-2: a credential's index record may carry
  renewable and heads_up_for.`
- Spec 030 AC-5 and spec 099 AC-3: `Amended by ... AC-2: no credential_expiry
  event is produced for a renewable credential whose heads_up_for equals its
  expires_at and whose last check passed.`
- Spec 028 AC-5: `Amended by ... AC-3: open_questions also takes a
  question's text from the maintainer.contact event of a sent request (kind
  credential, funds or first_contact, label request).`
- Spec 022 AC-3: `Amended by ... AC-2: the expiry line is read by ssoExpiry
  in src/aws/sso.ts and, for a session the CLI renews itself, shows the time
  a login is needed by, the cached registrationExpiresAt.`
- Spec 022 AC-9: `Amended by ... AC-7: a change of the forecast's state, to
  over the cap or back under it, re-arms the aws-forecast notice before it is
  sent, so the recovery is not rate-limited away.`

(The `...` above stands for the same link in every mark.) Spec 030 AC-13 is
not marked: the credential check agent's rule is unchanged and `aws-sso` is
one more entry it walks; the heads-up's skip is the scheduler's, in the
producer and the notifier, as AC-2 says. Spec 050 AC-3 is not marked: no kind is added.

## 5. Interfaces and files

- *(agent's call)* This list is the revision's, from `main` at 8cebdd3;
  paths without a prefix are under `tools/scheduler/`.
- `agents/credentials.yaml`: the `aws-sso` entry is on `main`; it gains
  `renew_steps` (AC-2). `schemas/scheduler/credential-catalogue.json` and
  `src/credentials/catalogue.ts` (`CredentialEntry`): the optional
  `renew_steps`.
- `src/aws/sso.ts` (new): `ssoExpiry(profile, env)` and `profileStanza`,
  moved from `src/aws/check.ts` (AC-2). `src/aws/check.ts`: `aws-check`'s
  expiry line uses it, `awsCheck(ctx, env?)`, and the open reservations show
  `scale.kind` and `scale.state` (AC-6). `src/aws/cli.ts`: unchanged.
  `src/aws/cost.ts`: `judge`'s clear of the `aws-forecast` identity on a
  change of state (AC-7), and nothing else in that file.
- `src/credentials/check.ts`: `CheckContext.aws` and `runCheck`'s `provider:
  aws` branch (AC-1), and `expiryEvents`' skip of a renewable credential
  already warned for (AC-2). `src/credentials/store.ts`: `writeExpiry` accepts
  null and writes `renewable`; `IndexEntry` gains `renewable` and
  `heads_up_for`, and `writeHeadsUp(name, expires_at)` (AC-2).
  `schemas/scheduler/credential-index.json`: the two optional fields.
  `bin/cred-exec.ts`: the `provider: aws` branch (AC-1).
  `src/credentials/commands.ts`: unchanged.
- `src/aws/scale.ts` (new): the three kinds' calls and the descriptor's
  validation (AC-6, AC-7). `src/aws/book.ts`: `scale` on `Reservation`.
  `src/aws/ledger.ts`: `scale` on `reserveSpend`'s input and the record,
  `scale.state`, the effective `expected_monthly_usd`, the `scaled` outcome
  (AC-6, AC-7); its funds notification and `contact` field are on `main`
  (AC-5).
- `src/actions/aws-scale.ts` (new): `awsScaleKind`. `src/actions/index.ts`:
  `KINDS.aws_scale` and `aws` on `ActionContext`. `agents/actions.yaml`: the
  entry (AC-7).
- `src/notify/`: on `main`, unchanged (AC-4).
- `bin/scheduler.ts`: the `aws sso-expiry` command (dispatched before
  `aws`'s status view), `CheckContext.aws`, and `aws` on the action context
  (AC-1, AC-2, AC-7).
- `src/state/questions.ts`: the `sent` contact's kind, label and `request`,
  and the answer event (AC-3). `src/service/loop.ts`'s two answer call sites,
  `src/chain/driver.ts`, `src/chain/question.ts` and
  `src/contacts/approve.ts`: unchanged.
- `src/reflection/input.ts`: `openQuestions`' selection (AC-3).
- `src/standing/infra-health-input.ts` and
  `schemas/scheduler/infra-health-input.json`: `aws` (AC-8).
  `src/standing/run.ts`: `aws` passed to the input builder, the
  `credential-expiry` steps taken from `renew_steps`, and `notifyCredential`'s
  heads-up text, skip and `heads_up_for` write (AC-2, AC-8).
  `src/service/loop.ts`: its `aws` passed on to the standing run's deps where
  it is not already. `agents/standing/infra-health.md`: `credentials`,
  `actions`, the prompt (AC-8).
- `schemas/scheduler/event.json`: `outcome` and the typed `request` on the
  `maintainer.contact` payload (AC-3; an untyped `request` is on `main`);
  `scaled` and `direction` on the `aws.reserve` payload (AC-7).
  `schemas/scheduler/aws-ledger.json`: `scale` (AC-6).
- `test/`: `aws.test.ts` (the descriptor, `aws_scale`'s checks and calls,
  the forecast after a scale, `ssoExpiry` over fixture files with each result
  of AC-2, renewable and not, the never-read-token assertion, `aws-check`'s
  line, the re-armed forecast notice through `rateLimited` with the default
  windows);
  `credentials.test.ts` (`renew_steps`, `runCheck`'s `provider: aws` branch:
  skipped, not set, wrong account, ok with the expiry and `renewable` written,
  `none` clearing it, the producer's skip, the index validating against its
  schema with the new fields); `bin.test.ts` (`cred-exec.ts`'s `provider: aws` branch and its
  refusals, `aws sso-expiry`); `events.test.ts` (the schema's new properties,
  the request's send and answer events); `reflection.test.ts` (AC-3);
  `infra-health-input.test.ts` (AC-8); `standing.test.ts` (the notification's
  steps, the heads-up once per `expires_at` and the day-two login case of AC-2); `actions.test.ts` (`aws_scale` in `KINDS`); `stages.test.ts` (the
  prompt pins); `e2e.test.ts` and `helpers/e2e-routes.ts` (AC-10).
  `notify.test.ts` is on `main` and is checked, not rewritten (AC-4).
  `test/helpers/fake-aws` gains the AC-7 calls; a fixture home under
  `test/fixtures/aws-home/` holds `.aws/config` and two cache files, one renewable (`sso_session`, a
  `refreshToken` and `registrationExpiresAt`) and one legacy, their token
  fields obvious fake markers; a test that needs a time relative to its
  clock writes its cache file into a temporary directory. A test
  may sit in a neighbouring file of this directory when that is where its
  subject is already tested.
- `tools/README.md`: `aws sso-expiry`, the `aws-sso` entry and its
  `renew_steps`, the six policy actions with the policy JSON (AC-2, AC-9).
- `specs/030-beyond-github/spec.md`,
  `specs/022-delivery-aws-account/spec.md`, `specs/026-event-store/spec.md`,
  `specs/064-disk-sweep-and-infra-health/spec.md`,
  `specs/099-beyond-github-rest-on-the-credential-store/spec.md`,
  `specs/028-reflection-agents/spec.md`: the marks of section 4 (this spec's
  PRs).
- `docs/delivery-system-design.md`: this spec under `## Children` (done in
  the first spec PR).

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
- *(agent's call, 2026-11-22)* On the laptop, the implement stage runs,
  from its branch, in this order, and quotes each command's output in the PR:
  `panelator-scheduler cred check aws-sso`, which makes the identity call for
  the stored profile and exits 0 with `check ok`; `panelator-scheduler aws
  sso-expiry`, which prints the time a login is needed by; and
  `panelator-scheduler aws-check`. The credential is already set: "The SSO
  session is live and `cred set aws-sso` stored `panelator-delivery`"
  (maintainer answer, question #7071686442), so `cred set` is run again only
  when `cred list` shows it missing. The identity call is the judge of the
  session, as the maintainer asked: "please run `aws sts get-caller-identity
  --profile panelator-delivery` before requesting another browser login ...
  If STS returns the delivery account ID, proceed with the remaining checks.
  If it fails, capture the error and request a login if the CLI reports that
  reauthentication is required." (maintainer answer, question #7076977958)
  `cred check aws-sso` is that call made through `src/aws/cli.ts`; a stage
  whose check fails quotes the error and asks as AC-9 says, and asks nothing
  while the check passes. No live `aws_scale` is run: the delivery account
  has no reservation with a descriptor (section 2), so the fake `aws` covers
  AC-7's calls and the PR says so; the first live scale is the dev-log entry
  below.
- After the service is restarted on the merged code, the first
  `credential-expiry` warning for `aws-sso`, the first `maintainer.contact`
  event with `channel: telegram`, and the first `aws_forecast_over_cap`
  alarm infra health handles (or, with the cap at 0, the first refused
  reservation's funds message) are written up in `dev-logs/` with their run
  records and event lines.

## 7. Open decisions

None.
