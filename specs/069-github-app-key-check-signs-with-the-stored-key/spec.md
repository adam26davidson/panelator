# 069. The `github-app-key` check signs with the key being set: a `wrapper: none` entry's check is a scheduler probe, not a shim command

Status: written 2026-11-15 from the delivery-system design for issue #131;
specs derived from that design need no maintainer approval (design section 11).
Amends [030-beyond-github](../030-beyond-github/spec.md) AC-2 (the `check`
field of a `wrapper: none` entry and the `github-app-key` entry's check) and
AC-4 (`cred set` tests the secret it just stored and exits non-zero when the
check fails), each marked as section 4 records. Revised 2026-11-15 in answer
to the plan stage: spec 030's implementation is on no branch that reaches
`main` (issue #39 is abandoned, its work unmerged on `origin/issue-39`), so
this spec now also carries the part of spec 030 the probe stands on, built as
spec 030 writes it: AC-1 (the store, the index, the `credentials` block),
AC-2 (the catalogue and its loader, as amended here), the App-key rule of
AC-3 and the commands of AC-4 (as amended here); section 1 ("How this reaches
`main`") says why and what it leaves to the issue that carries the rest of
spec 030. *(agent's call)* Revised again 2026-11-15 after two implement
attempts and a plan gap: spec 030 AC-4's action-log row per `cred` command
can only be written by `applyAction` with a kind defined in `src/actions/`
and `agents/actions.yaml` (spec 008 AC-8, AC-9), which this spec's section 5
listed as not touched; the `cred` commands are now the action kinds
`cred_set`, `cred_check`, `cred_import` and `cred_remove` (AC-10, section 1
"The commands are action kinds"), and spec 030 AC-4 and AC-16 carry marks
for it. *(agent's call)*
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Credentials": agents use credentials through wrappers and never
see the secret; "the credential check automates renewal wherever the provider
allows"), section 6.1 (the credential check on the roster), section 10
("Small work skips layers": a bug spec hangs directly off a top design) and
section 11 (row F2, the terminal state of an abandoned issue);
[001-scheduler-core](../001-scheduler-core/spec.md) section 12 (the App
private key mints the installation token in `token.json`; the `gh` wrapper
carries that token; the refresh every 50 minutes);
[030-beyond-github](../030-beyond-github/spec.md) AC-1 (the store,
`readSecret`, the index's `last_check`), AC-2 (the catalogue and its loader;
the `check` field, which this spec amends), AC-3 (the App key is read from
the store once `github-app-key` is set), AC-4 (`cred set`, `list`, `check`,
`import`, `remove`), AC-5 (a failed check produces `credential_expiry`), AC-8
(a credential "Done" is verified by the entry's check), AC-13 (the credential
check agent's input) and AC-14 (`renew_credential` re-runs the check);
[007-telegram-channel](../007-telegram-channel/spec.md) AC-1 (the Telegram
credentials file, the shape the `telegram-bot` secret keeps);
[008-agent-registry](../008-agent-registry/spec.md) AC-8 (an action kind is
code in `src/actions/` with an entry in `agents/actions.yaml`), AC-9 (the
action log the `cred` commands write to, through `applyAction`, its one
writer), AC-12 (the only `maintainer` actor is the command line) and AC-17
(the maintainer's commands: `param set` goes through a kind, `param list`
reads and is not logged);
[068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-1 (the `aws-sso` entry, whose check stays a command through its wrapper
and which this spec does not change) and section 1 ("What `main` must have
before this is built", which names spec 030's implementation).

## 1. Goal

The check of the `github-app-key` catalogue entry tests the key that is
stored: it signs an App JWT with that key, calls `GET /app`, and passes only
when GitHub answers with the configured App. A wrong, truncated or
mistyped key fails at `cred set`, when the maintainer is at the keyboard,
and not at the next token refresh up to 50 minutes later.

### What is wrong today

Spec 030 AC-2 defines `check` as "a command run through the wrapper whose
exit 0 means the credential works" and gives `github-app-key` the check
`gh api /app` through the existing `gh` shim. `GET /app` is an
App-authenticated endpoint: it accepts only a JWT signed with the App's
private key. The `gh` shim authenticates with the installation token from
`token.json` (`tools/scheduler/src/runner/credentials.ts`), so the check as
written can never pass. The implement stage of issue #39 (run
`39-implement-1-20261104T190619`) substituted
`gh api /installation/repositories --jq .total_count`, which passes, but
exercises the installation token minted from the key already in use, not the
key just stored: `cred set github-app-key` (spec 030 AC-4) runs the check to
tell the maintainer whether the new secret works, so a wrong new key passes
the check and breaks the service at the next refresh.

The entry has `wrapper: none`: nothing wraps the key, the scheduler reads it
itself. The same is true of `telegram-bot`, whose check spec 030 names as
`getMe`, which is a Telegram API method and not a command either. For both,
"a command run through the wrapper" describes nothing that exists. The
scheduler already knows how to sign with the key in process:
`createAppClient` in `tools/scheduler/src/github/auth.ts` builds an octokit
`App` from the private key, and its `botLogin()` calls `GET /app` with the
App JWT.

### The fix

1. **A `wrapper: none` entry's check is a probe the scheduler runs.** The
   catalogue's `check` field takes two forms: a command string for an entry
   with a wrapper (run through the wrapper, exit 0 means it works, as spec
   030 says), or `{ builtin: <name> }` for an entry with `wrapper: none`,
   naming a probe implemented in `tools/scheduler/src/credentials/check.ts`.
   Each probe reads the secret it tests with `readSecret(name)` (spec 030
   AC-1) and tests nothing else: not `token.json`, not the configuration
   file the secret was imported from, not a client built earlier from a
   different copy of the secret.
2. **The `github-app` probe signs with the stored key.** It builds an App
   client from the configured `app.id` and the stored key, calls `GET /app`
   with the App JWT, and passes only when the response's `id` equals
   `app.id`. It mints no installation token and writes nothing.
3. **The `telegram-get-me` probe is `getMe` with the stored token.** It is
   what spec 030 meant by `getMe`, named so that the catalogue loads under
   the rule of item 1.
4. **`cred set` reports the failure in its exit status too.** It stores the
   secret, runs the probe over the stored blob and prints the result as spec
   030 AC-4 says; when the check fails it exits 1, so a setup step that runs
   it in a shell stops there.
5. **The `cred` commands that change state are action kinds.** `cred set`,
   `cred check`, `cred import` and `cred remove` run through `applyAction`
   as the level-1 kinds `cred_set`, `cred_check`, `cred_import` and
   `cred_remove`, defined in `src/actions/` with entries in
   `agents/actions.yaml` (spec 008 AC-8), which is how spec 030 AC-4's "logged
   in the action log with `agent: maintainer` and `args.name` only" is met
   (below, "The commands are action kinds"). `cred list` reads and is not
   logged, as `param list` is not (spec 008 AC-17).

*(agent's call)* The probe is a scheduler builtin rather than a new
`panelator-scheduler` subcommand named as the check string (the way spec 068
AC-2's expiry probe is `panelator-scheduler aws sso-expiry`) because a
subcommand would be a command the catalogue runs "through the wrapper" of an
entry that has none, and because the two existing `wrapper: none` entries both
need the scheduler's own clients (octokit, the Telegram client), not a
spawn. `GET /app` with the App id compared is preferred to minting an
installation token in memory because it tests exactly the credential (the
key is registered to one App), needs no installation id to be right, and is
the call `botLogin()` already makes. The check keeps a wrong key in the store
rather than restoring the previous blob: spec 030 AC-4 stores then checks,
AC-3 reads the stored key for the next mint, and the maintainer who sees
`cred set` fail runs it again with the right key; a store that silently kept
an old key would report "set" for a key that is not in use. Every change is
cheap to reverse; no ADR (design section 3, item 2).

### The commands are action kinds

*(agent's call, answering the plan stage's second gap, 2026-11-15)* Spec
030 AC-4 says every `cred` command "is logged in the action log with
`agent: maintainer` (spec 008 AC-9), with `args.name` only". On `main` the
action log has one writer, `applyAction` (`src/actions/index.ts`), which
writes a row only for a kind that has code in `src/actions/` and an entry in
`agents/actions.yaml` (spec 008 AC-8; `registryActionsCheck` fails the
registry test for a kind with one and not the other), and the repository
test `applyAction is the only writer of the action log`
(`tools/scheduler/test/actions.test.ts`) fails for any other file under
`src/` or `bin/` that writes a row. The first version of this spec listed
`src/actions/` and `agents/actions.yaml` as not touched by this chain, so
AC-10 could not be met: two implement attempts edited the writer test and
were stopped for scope, a third wrote no rows and was escalated by the
review. The spec was wrong, not the attempts.

**The choice.** The commands go through `applyAction` as four new level-1
kinds (option (a) of the plan stage's question), not deferred to the issue
that carries the rest of spec 030 (option (b)). Spec 030 AC-4 is a recorded
rule of a landed spec and spec 008 AC-8 and AC-9 say how a maintainer
command that changes state is recorded: `param set` is the `set_parameter`
kind requested as `maintainer`, and the only command spec 008 keeps out of
the log is `param mode`, because "no action kind sets a mode" (AC-12,
AC-17). A `cred set` that is not logged would be a second exception with no
such reason, and the audit agent, which reads the log by kind, would not see
credentials being set or removed. Deferring would also leave this chain's
`cred` commands shaped one way and the next issue reshaping them. The cost
is five more files in scope, each a few lines, and no change to the writer
test.

**The shape.** Following spec 008 AC-9 ("the line for a request is written
before the effect, with status `pending`, and rewritten after it"), the
kind's `apply` *is* the effect: `src/actions/cred-set.ts` calls
`writeSecret` and `runCheck` of `src/credentials/`, `cred-check.ts` calls
`runCheck`, `cred-import.ts` reads the configuration file, calls
`writeSecret` and `runCheck`, `cred-remove.ts` calls `removeSecret`; and
`bin/scheduler.ts` dispatches `cred <verb>` through `applyAction` as
`maintainer` the way `param set` and `agent pause` do. `commands.ts` keeps
the parsing, the output lines and the exit status (AC-10 says how), and
`cred list` reads the index without a kind. The secret of `cred set` reaches
the kind through the `ActionContext` (a `credentials` field, as spec 064 gave
`sweep_volume` its `repoDir` and `onSweep`), never through `args`, so the
row holds `{ name }` and nothing else; the check result reaches the command
the same way (an `onResult` callback on that field), since a kind's `apply`
returns only its undo. Each kind's `check` refuses any actor other than
`maintainer` with the reason `maintainer only`, so a standing agent whose
`actions` list named one is refused and the refusal logged (spec 008 AC-8,
AC-12); each kind's undo is `null` (a removed blob cannot be restored, a set
blob replaced the previous one, a check is not reversible), which spec 008
AC-9 allows for kinds it does not name, and `action undo <id>` on such a row
exits non-zero as spec 008 AC-10 says for a null undo.

**The row's status.** A `cred set` whose check fails is `applied`: the
effect spec 030 AC-4 describes (encrypt, write the index entry, run the
check, print the result) completed, and the blob is in the store (AC-3). The
check's result lives in the index (`last_check`, `last_checked_at`, AC-5)
and in the command's output and exit status, not in the row's `reason`,
which spec 008 AC-9 keeps for a refusal or a failure of the effect. `failed`
is for an effect that did not complete (the `systemd-creds` spawn exiting
non-zero, an index write failing, a probe throwing out of `runCheck`), with
the error message as `reason`; the message carries no secret text (AC-7's
test reads the log). The same holds for `cred_check` (the row is `applied`
when the check ran, whatever it returned, `skipped` included) and
`cred_import`. The decision is cheap to reverse (four small files and four
entries); no ADR.

### How this reaches `main`

*(agent's call, answering the plan stage, 2026-11-15)* Every file the fix
touches belongs to spec 030's implementation, and none of it is on `main`:
`main` at bb37d65 has no `tools/scheduler/src/credentials/`, no
`agents/credentials.yaml`, no `schemas/scheduler/credential-catalogue.json`
and no fake `systemd-creds`. Issue #39, which carried spec 030, was
abandoned a second time on 2026-11-05 (the fix loop's bound on the contacts
gate of AC-11, not on the credential half); its unmerged work is
`origin/issue-39` at 3b4aa7d, 76 `main` commits behind; no re-triage or
rewrite of it exists. A chain builds on `origin/main` in its own worktree,
so a spec that only amends spec 030's text names no path that exists, and
the plan stage cannot plan it.

**The rule.** This chain builds the part of spec 030 the probe stands on,
as spec 030 writes it, and the probe on top of it:

- spec 030 AC-1 in full: the `credentials` block of `agents/scheduler.yaml`,
  the store directory, the `systemd-creds` blobs, `index.json`,
  `readSecret` and `writeSecret`, the secret never leaving memory (AC-7
  below);
- spec 030 AC-2 as amended by AC-1 of this spec: the catalogue file, its
  loader and its loading rules, and the three entries `github-app-key`,
  `telegram-bot` and (per spec 068 AC-1) `aws-sso` (AC-8 below). Its last
  sentence, the profile field `credentials` in place of `credential_hook`,
  is not built here: the field exists to drive the shim directory of AC-3,
  and goes with it;
- the one rule of spec 030 AC-3 that concerns the key: "the App key that
  mints `token.json` is read from the store once `github-app-key` is set,
  else from `app.private_key_path` as today" (AC-9 below). The shim
  directory, `cred exec` and the per-run `PATH` are not built here;
- spec 030 AC-4 as amended by AC-3 and AC-10 of this spec: `cred set`,
  `cred list`, `cred check`, `cred import` and `cred remove`, the four that
  change state logged in the action log as the kinds `cred_set`,
  `cred_check`, `cred_import` and `cred_remove` of `src/actions/` and
  `agents/actions.yaml` (AC-10 below; "The commands are action kinds"
  above). `cred exec` goes with the shims.

Everything else of spec 030 is left to the issue that carries the rest of
it: the shims and `cred exec` (AC-3), the `credential_expiry` producer
(AC-5), the request object, its rendering and the "Done" path (AC-6 to
AC-8), the `TelegramNotifier` and alert replies (AC-9, AC-10), the contacts
gate (AC-11, AC-12), the credential check agent (AC-13), `renew_credential`
(AC-14), AC-16 and AC-17. No such issue exists today: the finding this run
files asks the filer for one (a rewrite of #39 or a new issue), blocked by
#131 (spec 066), so that it builds on a `main` that has
`src/credentials/`; spec 068's "What `main` must have" paragraph then names
that issue and this one. Each of those parts calls the probe through the
one function `runCheck` of AC-5 below, which this chain leaves in place for
them.

**Why this way and not the other two.** A split (a sub-design under
`docs/designs/` with the credential half of spec 030 and the probe as
planned children, the probe `after:` the half) would make the scheduler file
the issues and order them, but spec 030 is already the spec of that work and
a child of the top design; a sub-design that re-broke it into children would
cover the same parts twice (review criterion 8), and the first child would
build spec 030 AC-2 as marked, which is the probe, so the second child would
be empty. A "What `main` must have" paragraph alone (as spec 068 section 1
has) would name an issue that does not exist, and a claimed issue has no
path to wait for it: the plan stage would find the paths missing again and
the chain would spend its attempts to reach `abandoned`. Building the
foundation here is the one way #131's own chain can land the fix. It is more
than the issue's one check, but every added criterion is spec 030's own text
built unchanged, not a new rule; what the issue asks for (a `cred set` that
reports the key it stored) does not exist without `cred set` and the store.
`origin/issue-39` at 3b4aa7d is a permitted starting point for `store.ts`,
`catalogue.ts`, `commands.ts`, the two schemas, the fake `systemd-creds` and
`credentials.test.ts` where a file, rebased onto `main`, meets the criteria
below (its catalogue used `builtin:<name>` as a string and the substitute
check; neither passes AC-1); nothing in it has to be used. The decision is
cheap to reverse (it adds files spec 030 already names, under spec 030's own
rules); no ADR.

## 2. Out of scope

- Any change to how the `gh` shim or `git-credential-panelator.ts`
  authenticate (the installation token from `token.json`, spec 001 section
  12), or to the token refresh and its retries in `src/github/auth.ts`.
- Falling back to `app.private_key_path` when the stored key fails its
  check. Spec 030 AC-3's rule (the store once set, else the configuration
  path) is unchanged; the fix is that a bad key is reported when it is set.
- The `aws-sso` entry (spec 068 AC-1): its check is a command through its
  wrapper, run by `src/aws/cli.ts`, and its expiry probe spawns nothing.
  Neither changes. Its entry is in the catalogue this chain writes (spec 068
  AC-1 fixes its text); running its check or probe needs spec 022 and spec
  068's implementations and is theirs. The loader of AC-8 accepts the entry;
  `cred check` reports it `skipped: wrapper not built` until the shims
  exist *(agent's call)*.
- Comparing the key's permissions with the entry's `access` list, or
  checking the installation (`app.installation_id`) exists: the credential
  is the key; the installation is configuration.
- Verifying a key before storing it, or keeping the previous blob when the
  check fails (section 1 says why).
- The rest of spec 030 (section 1, "How this reaches `main`"): the shims,
  `cred exec`, the `credentials` profile field, the `credential_expiry`
  producer, the requests and the "Done" path, the notifier, the contacts
  gate, the two standing agents, `renew_credential`. Spec 069 AC-5 says how
  they will call the probe; none is built or tested here beyond that.
- The Telegram poller reading `telegram-bot` from the store. Spec 030 says
  that only of the App key; the poller keeps reading
  `telegram.credentials_path` (spec 007). `cred import` says so when it
  lists the files (AC-10).

## 3. Acceptance criteria

"Given" states use spec 030 section 3's fakes: the fake harness, the mocked
GitHub API, the fake Telegram server of spec 007 and a fake `systemd-creds`
on `PATH` whose encrypt and decrypt are reversible and whose output goes to
a fixture directory; this chain adds the fake, under
`tools/scheduler/test/helpers/`, since spec 030's was never merged. The
*test key* is an RSA key pair generated by the test (`node:crypto`), its
private half stored through the fake `systemd-creds`; the mocked GitHub
answers `GET /app` only to an `Authorization: Bearer <jwt>` header whose JWT
verifies (RS256) against the test key's public half and whose `iss` is the
configured `app.id`, returning `{ id: <app.id>, slug: <bot slug> }`; any
other request to `GET /app` gets 401. *Store directory*, *index*: spec 030
AC-1's, built by AC-7.

- AC-1. **The catalogue's `check` has a form for each kind of entry.**
  `agents/credentials.yaml`'s `check` is either a string (an entry with a
  `wrapper`: the command run through the wrapper, exit 0 meaning the
  credential works, as spec 030 AC-2 says) or `{ builtin: <name> }` (an
  entry with `wrapper: none`: a probe of `src/credentials/check.ts`, named
  `github-app` or `telegram-get-me`). Given an entry with `wrapper: none`
  and a string check, an entry with a wrapper and a `builtin` check, or a
  `builtin` the code does not implement, then loading fails as spec 030 AC-2
  does for an unknown key, naming the entry and the rule, and the same
  checks run in the vitest test over the repository file.
  `schemas/scheduler/credential-catalogue.json` says the same (`check` is
  `oneOf` a string and `{ builtin: enum }`). The repository catalogue has
  `github-app-key: check: { builtin: github-app }` and `telegram-bot: check:
  { builtin: telegram-get-me }`; the `aws-sso` entry keeps its command.
- AC-2. **The `github-app` probe tests the stored key and nothing else.**
  Given `github-app-key` set to the test key, when the probe runs (by `cred
  set` or `cred check` in this chain; by the credential check's pre-run of
  spec 030 AC-13 or a credential "Done" of spec 030 AC-8 once the issue that
  carries them builds them, AC-5), then it reads the key with
  `readSecret("github-app-key")`, builds an App client from `app.id` and
  that key (`createAppClient`, with the fetch the scheduler injects for
  tests), calls `GET /app` with the App JWT, and the check is `ok` when the
  response's `id` equals `app.id`. Given the stored key is not a PEM private
  key (garbage, a truncated file, a public key), then the check is `failed:
  key does not parse`; given GitHub answers 401 (a key not registered for
  the App; in the test, a second generated key), then `failed: GitHub
  refused the JWT (401)`; given `GET /app` returns an `id` other than
  `app.id`, then `failed: key belongs to App <id>, configured App is
  <app.id>`; given a network or 5xx error, then `failed: <status or
  error>`. The reason never contains the key text or any part of it. The
  probe mints no installation token, and a test asserts that `token.json`
  is unchanged (same bytes and mtime) after a probe, that the probe makes
  exactly one request, to `GET /app`, and that it works with no
  `token.json` present. The probe never reads `app.private_key_path`: given
  the store has the test key and the configuration path holds a different
  valid key, then the probe's JWT verifies against the test key.
- AC-3. **`cred set` reports whether the key it stored works.** Given `cred
  set github-app-key` with the test key on stdin, then the blob is written,
  the index entry has `set_by: maintainer`, the probe runs over the stored
  blob, `last_checked_at` is set and `last_check` is `ok`, the command
  prints `github-app-key: check ok` and exits 0. Given the same with a key
  GitHub refuses, then the blob is written all the same (spec 030 AC-3's
  rule for which key mints the token is unchanged), `last_check` is `failed:
  GitHub refused the JWT (401)`, the command prints `github-app-key: check
  failed: GitHub refused the JWT (401)` followed by the entry's `setup`
  steps, and exits 1. This is the test the issue asks for: it fails against
  the substitute check (a mocked `/installation/repositories` answering 200
  for the installation token would let the wrong key pass) and passes with
  the probe. `cred check [<name>]` applies the same probe and index update
  and exits 1 when any check it ran failed.
- AC-4. **The `telegram-get-me` probe is `getMe` with the stored token.**
  Given `telegram-bot` set to a JSON secret `{ bot_token, chat_id }` (the
  shape of spec 007 AC-1's credentials file, so `cred import` stores that
  file as it is), then the probe calls the fake Telegram's `getMe` with that
  token and is `ok` on a 200 with `ok: true`, `failed: unauthorized` on 401,
  `failed: <status or error>` otherwise, and `failed: secret is not {
  bot_token, chat_id }` when the blob does not parse or has another shape.
  The reason never contains the token. The poller's own `getMe` and its
  `telegram` log lines (spec 007) are unchanged, and the poller keeps
  reading `telegram.credentials_path` (section 2).
- AC-5. **One function runs the entry's check, for this chain and the
  next.** `runCheck(entry, ctx)` in `src/credentials/check.ts` dispatches on
  the check's form (a command through the wrapper; a `builtin` probe), returns
  `{ status: "ok" } | { status: "failed", reason } | { status: "skipped",
  reason }`, and writes `last_checked_at` and `last_check` to the index; it
  is the only place the index's check fields are written. In this chain its
  callers are `cred set` and `cred check` (AC-3, AC-10). The credential
  check's pre-run (spec 030 AC-13), the `credential_expiry` producer (AC-5),
  the "Done" path (AC-8: `done (verified)` or `done (check failed:
  <reason>)`) and `renew_credential` (AC-14) are not built here; when the
  issue that carries the rest of spec 030 builds them, each calls this
  function and adds nothing of its own to the check. The test of the "Done"
  path with a refused key that this spec first named is dropped from this
  spec and kept against `runCheck` only: given `github-app-key` set to a key
  GitHub refuses, when `runCheck` runs over the repository catalogue's
  entry, then it returns `failed: GitHub refused the JWT (401)` and the index
  shows the same, so the "Done" path, when built, has the reason it resumes
  the stage with. Given an entry whose check is a command and whose wrapper
  is not built (today, `aws-sso`), then `runCheck` returns `skipped: wrapper
  not built`, `last_check` is `null` and `cred check` does not count it as
  failed *(agent's call: a skipped check is not a failed credential, and the
  shims are not this chain's)*.
- AC-6. **The earlier text is marked.** Spec 030 AC-2 and AC-4 carry the
  marks of section 4, and their earlier text follows unchanged.

**The ground the probe stands on** (spec 030 AC-1 to AC-4, built here as
spec 030 writes them; section 1, "How this reaches `main`")

- AC-7. **The store of spec 030 AC-1, in full.** Given `agents/scheduler.yaml`
  with a `credentials` block (`dir`, default `~/.config/panelator/credentials`;
  `warn_days`, default 7, min 1; an unknown key or a `warn_days` under 1
  fails loading as `config.ts` does for the other blocks), or without one
  (the defaults apply), then `writeSecret(name, text)` in
  `src/credentials/store.ts` produces `<dir>/<name>.cred` through
  `systemd-creds --user encrypt --name=<name>` (the command path injectable
  for the fake, as spec 030 section 5 says) and writes the index entry
  (`name`, `created_at`, `set_by`, `expires_at`, `last_checked_at`,
  `last_check`) to `<dir>/index.json`; `readSecret(name)` decrypts the blob
  into memory and is the only decryption; given `dir` does not exist, then
  the first `cred set` creates it with mode `0700`. A test asserts the blob
  is not the plaintext, `index.json` holds no secret, and after a check the
  secret is in no log line, run record, event payload or file of the state
  directory (the "after a wrapped call" half of spec 030 AC-1's test waits
  for the shims). `schemas/scheduler/credential-index.json` describes the
  index. `warn_days` is read and validated here and used by nothing until
  the producer (spec 030 AC-5) is built.
- AC-8. **The catalogue of spec 030 AC-2, as amended.** `agents/credentials.yaml`
  and its loader in `src/credentials/catalogue.ts` carry the fields spec 030
  AC-2 lists (`name`, `provider`, `purpose`, `access`, `used_by`, `wrapper`,
  `expiry`, `check`, `renew`, `setup`), with `check` in the two forms of
  AC-1, and the loading rules of spec 030 AC-2 (an unknown key, a missing
  required key, a `wrapper` command wrapped by two entries, a `used_by`
  naming a profile or standing agent that does not exist; `scheduler` is a
  valid `used_by` for a `wrapper: none` entry the scheduler uses itself
  *(agent's call)*), each failing loading as spec 008 AC-1 does and each
  run as a vitest test over the repository file. The repository catalogue
  holds `github-app-key` and `telegram-bot` as spec 030 AC-2 writes them
  (with this spec's checks) and `aws-sso` as spec 068 AC-1 writes it.
  `schemas/scheduler/credential-catalogue.json` describes the file. The
  profile field (`credentials` in place of `credential_hook`) is not changed
  here (section 2).
- AC-9. **The App key is read from the store once set (spec 030 AC-3's
  rule).** Given the index has `github-app-key` and its blob decrypts, when
  the scheduler starts (`bin/scheduler.ts`, where `app.private_key_path` is
  read today), then the key that `createAppClient` signs with is
  `readSecret("github-app-key")`, through one helper in `src/credentials/`,
  and `app.private_key_path` is not read; given the index has no such
  entry, then the path is read as today. Given the stored key is set but
  does not decrypt (the fake made to fail), then the scheduler fails to
  start with a message naming the credential and `cred set`, as it does
  today for an unreadable path, and the message carries no key text. The
  `gh` shim, `git-credential-panelator.ts`, `token.json` and the refresh are
  unchanged (spec 001 section 12). A test asserts that with the test key in
  the store and a different key at the path, the first `GET /app` the
  started scheduler makes (`botLogin()`) carries a JWT the test key
  verifies.
- AC-10. Amended by [072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md) AC-7: `cred import` prints both files as safe to delete after the service has restarted, with the scheduler reminding the maintainer while one remains. **The commands of spec 030 AC-4, as amended.** `panelator-scheduler
  cred set <name>` (stdin only; the name must be in the catalogue; stores,
  writes the index entry with `set_by: maintainer`, runs `runCheck`, prints
  the result and exits as AC-3 says), `cred list` (each entry with set or
  missing, expiry, last check; never the secret), `cred check [<name>]`
  (runs `runCheck` for the named or every entry, exits 1 when any returned
  `failed`), `cred import` (reads `app.private_key_path` and
  `telegram.credentials_path`, stores them as `github-app-key` and
  `telegram-bot` with `set_by: import`, runs their checks, and prints the
  two files: the `.pem` as safe to delete after the service has restarted
  and minted from the store, the Telegram file as still read by the poller
  until a later spec moves it *(agent's call, section 2)*) and `cred remove
  <name>` (deletes the blob and the entry). Each command but `cred list` is
  logged in the action log with `agent: maintainer` and `args.name` only
  (spec 008 AC-9), as spec 030 AC-4 says, by running through `applyAction`
  as the kind of AC-11 (`cred_set`, `cred_check`, `cred_import`,
  `cred_remove`), one row per credential acted on: `cred check` with no
  name writes one `cred_check` row per catalogue entry, `cred import` one
  `cred_import` row per file. `bin/scheduler.ts` dispatches `cred <verb>`
  through `applyAction` as `maintainer` with `run_id: command` and a `why`
  of at least 20 characters, the way `param set` and `agent pause` do;
  `commands.ts` parses the verbs, prints the lines and sets the exit status.
  `cred list` reads the index and writes no row, as `param list` does not
  (spec 008 AC-17) *(agent's call)*. A test asserts that after `cred set`,
  `cred check`, `cred import` and `cred remove`, `action list` shows one row
  per credential with `agent: maintainer`, `args: { name }` and no other
  key, and that `cred list` added none. The expiry probe of `cred check`
  (`expiry: { probe }`) runs through the wrapper and so is `skipped` with the
  check until the shims exist; `expiry: index` and `none` are read as spec
  030 says.
- AC-11. **The `cred` kinds are actions of spec 008 AC-8.** `agents/actions.yaml`
  gains `cred_set`, `cred_check`, `cred_import` and `cred_remove`, each
  `level: 1` with a one-line description, and `src/actions/` gains one file
  per kind (`cred-set.ts`, `cred-check.ts`, `cred-import.ts`,
  `cred-remove.ts`) registered in `KINDS` of `src/actions/index.ts`, so the
  registry test of spec 008 AC-1 and `registryActionsCheck` pass unchanged.
  Each kind's `args` is `{ name }` exactly (`exact(args, ["name"])`), its
  `changesMode` is `false` and its `undo` is `null`. Each kind's `check`
  returns `maintainer only` when the actor is not `maintainer` (so a
  standing agent whose `actions` list names one is refused and the refusal
  logged, spec 008 AC-8 and AC-12), `unknown credential <name>` when the
  name is not in the catalogue, and for `cred_import` `cannot read <path>`
  when the configuration file of the credential is not readable (the path
  is configuration, not secret). Each kind's `apply` is the command's
  effect, calling into `src/credentials/`: `cred_set` calls `writeSecret`
  with `set_by: maintainer` then `runCheck`; `cred_check` calls `runCheck`;
  `cred_import` reads the file, calls `writeSecret` with `set_by: import`
  then `runCheck`; `cred_remove` calls `removeSecret`. The secret of
  `cred_set` and the check result travel through a `credentials` field of
  `ActionContext` (the secret as a function the command sets from stdin,
  the result through an `onResult(name, result)` callback), never through
  `args` or the row. Given `cred set` with a key GitHub refuses, then the
  row is `status: applied` with no `reason` (the blob was stored, AC-3; the
  check's result is the index's `last_check` and the command's exit 1);
  given `writeSecret` throws (the fake `systemd-creds` made to exit
  non-zero), then the row is `status: failed` with the error as `reason`,
  no index entry is written and the command exits 1; a test asserts both
  rows and that neither `reason` nor any other field of the log holds the
  key text. `action undo <id>` on a `cred_*` row exits non-zero with the
  reason spec 008 AC-10 gives for a null undo. The repository test
  `applyAction is the only writer of the action log`
  (`tools/scheduler/test/actions.test.ts`) is unchanged and passes: no file
  under `src/credentials/` or `bin/` writes a row. `schemas/scheduler/action.json`
  leaves `kind` a free string and is not changed.

## 4. Amendments to earlier specs

- Spec 030 AC-2 is marked `Amended by
  [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
  AC-1: a `wrapper: none` entry's `check` is `{ builtin: <name> }`, a probe
  the scheduler runs over the stored secret; `github-app-key`'s check is the
  `github-app` probe (an App JWT signed with the stored key calling `GET
  /app`, AC-2), not `gh api /app` through the `gh` shim, and `telegram-bot`'s
  is `telegram-get-me`.` The earlier text, including spec 068's mark before
  it, stays as the record.
- Spec 030 AC-4 is marked `Amended by
  [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
  AC-3: `cred set` runs the check over the secret it just stored and exits 1
  when the check fails; `cred check` exits 1 when any check it ran failed.`
  and, beside it, `Amended by
  [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
  AC-10: the action-log row is written by the kinds `cred_set`, `cred_check`,
  `cred_import` and `cred_remove` through `applyAction`, one row per
  credential acted on, and `cred list`, which reads only, is not logged.`
- Spec 030 AC-16 is marked `Amended by
  [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
  AC-11: `agents/actions.yaml` also gains the four `cred_*` kinds, so
  `renew_credential` is not its one new kind.` The criterion's rule (no AWS
  action in spec 030) is unchanged; only its count of new kinds is.

Spec 030 AC-1, AC-3, AC-5, AC-8, AC-13 and AC-14 are not amended: AC-1, the
App-key rule of AC-3 and AC-4 are built here as written (AC-7 to AC-10), and
the others say "the entry's check" or "the check" and apply as written to
the probe when their issue builds them. Spec 068 AC-1 is not amended: the
`aws-sso` entry has a wrapper and its check stays a command. Spec 001
section 12 is not amended: the `gh` shim and the token refresh are
untouched. Spec 008 is not amended: AC-8 says kinds are added as code in
`src/actions/` with entries in `agents/actions.yaml`, and the `cred_*` kinds
are added that way (AC-11), as spec 064's `sweep_volume` and spec 068's
`aws_scale` were. Spec 068 section 1's "What `main` must have" paragraph is not
edited here (it is not a criterion this spec supersedes); the finding of
section 1 asks that it name the two issues.

## 5. Interfaces and files

The rule: this chain creates the files of spec 030 section 5 that AC-7 to
AC-10 need and no other of spec 030's, and the probe's files on top of them.
Everything below is new on `main` unless marked *(exists)*.

- `tools/scheduler/src/credentials/store.ts`: `readSecret`, `writeSecret`,
  `removeSecret`, the index read and write, the `systemd-creds` spawn with
  the command path injectable, the `0700` directory (AC-7); the one helper
  that gives `bin/scheduler.ts` the App key from the store or the path
  (AC-9).
- `tools/scheduler/src/credentials/catalogue.ts`: the loader, the two forms
  of `check` and the loading rules (AC-1, AC-8).
- `tools/scheduler/src/credentials/check.ts`: `runCheck(entry, ctx)`
  dispatching on the form and writing the index's check fields; the probes
  `github-app` (AC-2) and `telegram-get-me` (AC-4), each reading its secret
  with `readSecret`; `skipped` for a wrapper not built (AC-5).
- `tools/scheduler/src/credentials/commands.ts`: the `cred` verbs parsed,
  each credential acted on passed to `applyAction` with its kind, the output
  lines, the exit status; `cred list` reading the index (AC-3, AC-10). It
  writes no action-log row itself.
- `tools/scheduler/src/actions/cred-set.ts`, `cred-check.ts`,
  `cred-import.ts`, `cred-remove.ts`: the four kinds, their `check` (the
  actor, the name, the readable file) and their `apply` calling into
  `src/credentials/` (AC-11); `tools/scheduler/src/actions/index.ts`
  *(exists)*: the four added to `KINDS`, and the `credentials` field of
  `ActionContext` (store, catalogue, the probe context, the stdin secret
  function, `onResult`), the existing functions unchanged (AC-11).
- `agents/actions.yaml` *(exists)*: the four `cred_*` entries, `level: 1`
  with a description each (AC-11).
- `tools/scheduler/bin/scheduler.ts` *(exists)*: the `cred` subcommands
  dispatched to `commands.ts`, which runs them through `applyAction` as
  `maintainer` with the `credentials` context field set (AC-10, AC-11); the
  App key read through the store helper where `app.private_key_path` is
  read today (AC-9).
- `tools/scheduler/src/config.ts` *(exists)* and `agents/scheduler.yaml`
  *(exists)*: the `credentials` block, its defaults and validation (AC-7).
- `tools/scheduler/src/github/auth.ts` *(exists)*: `createAppClient` is
  reused with the stored key; if a helper is needed to call `GET /app`
  without a configured installation, it is added beside `botLogin()` and
  the existing functions are unchanged (AC-2).
- `agents/credentials.yaml`: the three entries (AC-1, AC-8); the
  `github-app-key` `setup` steps end with `panelator-scheduler cred set
  github-app-key < <the .pem>` and say that the command prints `check ok`
  when the key is registered for the App.
- `schemas/scheduler/credential-catalogue.json` (`check` as `oneOf` a
  string and `{ builtin: "github-app" | "telegram-get-me" }`) and
  `schemas/scheduler/credential-index.json` (AC-7, AC-8).
- `tools/scheduler/test/helpers/fake-systemd-creds`: the reversible fake
  (section 3).
- `tools/scheduler/test/credentials.test.ts`: AC-1 to AC-5 and AC-7 to
  AC-11 (the catalogue rules, the test key and the JWT-verifying `GET /app`
  route, the `cred set` exit status, `token.json` untouched, the reasons
  without the secret, the blob not plaintext, the key read from the store
  at start, `runCheck` over a refused key, `skipped` for `aws-sso`, the
  action-log rows of AC-10 and AC-11 including the `maintainer only`
  refusal and the `failed` row, all in this file and not in
  `actions.test.ts`); the
  `GET /app` route in `tools/scheduler/test/helpers/mock-github.ts` or
  `e2e-routes.ts` where the start-up test of AC-9 needs it. The existing
  recorded chains run unchanged with no `credentials` block (spec 030
  section 6's last item), which the existing e2e tests show by passing.
- `tools/README.md` *(exists)*: the `cred` commands, the `credentials`
  block, the catalogue and the two forms of `check`, what `cred set`'s exit
  status means (the documentation spec 030 section 5 names for its tool).
- `specs/030-beyond-github/spec.md` AC-2, AC-4 and AC-16: the marks of
  section 4 (AC-6).
- `docs/delivery-system-design.md`: this spec under `## Children`; the spec
  030 bullet says which issue builds which part.

Not touched by this chain, though spec 030 section 5 names them:
`src/credentials/shims.ts`, `src/runner/credentials.ts`, `src/runner/run.ts`
(the shim directory), `src/profiles/resolve.ts`, `src/stages/definition.ts`,
`src/types.ts`, `agents/profiles/*/profile.yaml`, `schemas/scheduler/profile.json`
and `standing-definition.json` (the `credentials` field), `src/service/loop.ts`
(the hourly producer), `src/contacts/`, `src/notify/telegram.ts`,
`src/telegram/`, `src/chain/`, `src/decide/`, `src/actions/renew-credential.ts`
(spec 030 AC-14's kind; the `cred_*` kinds of AC-11 are this chain's),
`src/standing/`, `agents/standing/credential-check.md`,
`agents/stages/*.md`, the `question.json`, `contacts.json` and
`credential-check-result.json` schemas. Also not touched, though not spec
030's: `tools/scheduler/test/actions.test.ts` (its `applyAction is the only
writer` test must pass as it is; the `cred_*` tests are in
`credentials.test.ts`), `schemas/scheduler/action.json` and
`schemas/scheduler/action-log-entry.json` (`kind` is a free string in
both). An implement stage that finds it needs one of them has found a gap
in this spec, not permission.

`tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`docs/delivery-system-design.md` are sensitive paths; the security review
applies to the implementation PR (spec 006 AC-9). Nothing here changes the
sensitive-path list, the security criteria, what routes a sensitive diff to
the security review, section 3 of the design, or any text marked as a
maintainer answer. The probe adds no network listener; its one outbound call
is `GET /app` to the configured GitHub API, which the scheduler already makes
at start-up (`botLogin()`). The store spawns `systemd-creds` and nothing
else; the secret is read into memory for one probe or one start-up and is
in no log line, reason string, run record or event, as spec 030 AC-1
requires; the AC-2, AC-4, AC-7, AC-9 and AC-11 tests assert it. The four
`cred_*` kinds give no agent a new capability: each refuses any actor but
`maintainer`, the actor only the command line can be (spec 008 AC-12), and
a standing agent that names one in its `actions` list is refused and logged.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added and every existing recorded chain unchanged.
- The AC-3 test (a key GitHub refuses makes `cred set github-app-key` exit 1
  with `last_check` failed) fails against a catalogue whose check is `gh api
  /installation/repositories --jq .total_count` with the mocked route
  answering 200, and passes with the probe. The AC-1 catalogue test fails on
  a repository catalogue whose `github-app-key` check is a string.
- A grep of `tools/scheduler/src` shows `GET /app` requested in
  `github/auth.ts` only, `readSecret` called from `credentials/` and
  `actions/cred-*.ts` only, `writeSecret` and `removeSecret` called from
  `actions/cred-*.ts` only, `systemd-creds` spawned from
  `credentials/store.ts` only, and `writePending(` in `actions/index.ts` and
  `actions/log.ts` only (the unchanged writer test says the same).
- `git diff --stat origin/main` of the implementation PR touches no file
  the "Not touched by this chain" paragraph of section 5 lists, and
  `agents/actions.yaml` differs from `main` by the four `cred_*` entries
  only.
- After the AC-10 test's commands, `panelator-scheduler action list` prints
  rows whose `kind` is one of the four and whose `args` is `{ name }`; the
  audit input of spec 008 groups them by kind with no change to
  `src/standing/`.
- On the laptop, after the implementation is deployed: the maintainer runs
  `panelator-scheduler cred set github-app-key < <the current .pem>`, which
  prints `check ok` and exits 0, then `panelator-scheduler cred check
  github-app-key`, which does the same; after the service restarts, its log
  shows the token minted (the refresh line) with the key read from the
  store, and the `.pem` can be deleted. Storing the key is the maintainer's
  step, done after merge: the implement stage does not ask for it, since
  nothing in this chain depends on the store being populated (the path
  keeps working until it is) *(agent's call; spec 030 section 6's
  capability question is not raised by this chain)*. The failing cases are
  exercised only by the tests: a wrong key is not stored on the laptop,
  since spec 030 AC-3 would mint from it at the next start.

## 7. Open decisions

None.
