# 069. The `github-app-key` check signs with the key being set: a `wrapper: none` entry's check is a scheduler probe, not a shim command

Status: written 2026-11-15 from the delivery-system design for issue #131;
specs derived from that design need no maintainer approval (design section 11).
Amends [030-beyond-github](../030-beyond-github/spec.md) AC-2 (the `check`
field of a `wrapper: none` entry and the `github-app-key` entry's check) and
AC-4 (`cred set` tests the secret it just stored and exits non-zero when the
check fails), each marked as section 4 records.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Credentials": agents use credentials through wrappers and never
see the secret; "the credential check automates renewal wherever the provider
allows"), section 6.1 (the credential check on the roster) and section 10
("Small work skips layers": a bug spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) section 12 (the App
private key mints the installation token in `token.json`; the `gh` wrapper
carries that token; the refresh every 50 minutes);
[030-beyond-github](../030-beyond-github/spec.md) AC-1 (`readSecret`, the
index's `last_check`), AC-2 (the catalogue's `check` field, which this spec
amends), AC-3 (the App key is read from the store once `github-app-key` is
set), AC-4 (`cred set` and `cred check` run the check), AC-5 (a failed check
produces `credential_expiry`), AC-8 (a credential "Done" is verified by the
entry's check) and AC-13 (the credential check agent's input);
[068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-1 (the `aws-sso` entry, whose check stays a command through its wrapper
and which this spec does not change).

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

## 2. Out of scope

- Any change to how the `gh` shim or `git-credential-panelator.ts`
  authenticate (the installation token from `token.json`, spec 001 section
  12), or to the token refresh and its retries in `src/github/auth.ts`.
- Falling back to `app.private_key_path` when the stored key fails its
  check. Spec 030 AC-3's rule (the store once set, else the configuration
  path) is unchanged; the fix is that a bad key is reported when it is set.
- The `aws-sso` entry (spec 068 AC-1): its check is a command through its
  wrapper, run by `src/aws/cli.ts`, and its expiry probe spawns nothing.
  Neither changes.
- Comparing the key's permissions with the entry's `access` list, or
  checking the installation (`app.installation_id`) exists: the credential
  is the key; the installation is configuration.
- Verifying a key before storing it, or keeping the previous blob when the
  check fails (section 1 says why).
- Spec 030's requests, gate, notifier and standing agents (AC-6 to AC-17)
  beyond what AC-8 and AC-13 inherit by running "the entry's check".

## 3. Acceptance criteria

"Given" states use spec 030 section 3's fakes: the fake harness, the mocked
GitHub API, the fake Telegram server of spec 007 and the fake `systemd-creds`.
The *test key* is an RSA key pair generated by the test (`node:crypto`), its
private half stored through the fake `systemd-creds`; the mocked GitHub
answers `GET /app` only to an `Authorization: Bearer <jwt>` header whose JWT
verifies (RS256) against the test key's public half and whose `iss` is the
configured `app.id`, returning `{ id: <app.id>, slug: <bot slug> }`; any
other request to `GET /app` gets 401. *Store directory*, *index*: spec 030
AC-1's.

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
  set`, `cred check`, the credential check's pre-run of spec 030 AC-13, or a
  credential "Done" of spec 030 AC-8), then it reads the key with
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
  Given `telegram-bot` set to a JSON secret `{ token, chat_id }`, then the
  probe calls the fake Telegram's `getMe` with that token and is `ok` on a
  200 with `ok: true`, `failed: unauthorized` on 401, `failed: <status or
  error>` otherwise, and `failed: secret is not { token, chat_id }` when the
  blob does not parse. The reason never contains the token. The poller's
  own `getMe` and its `telegram` log lines (spec 007) are unchanged.
- AC-5. **The rest of spec 030 reads the probe as the entry's check.** The
  credential check's pre-run (spec 030 AC-13), the `credential_expiry`
  producer (AC-5: a failed check produces the event) and the "Done" path
  (AC-8: `done (verified)` or `done (check failed: <reason>)`) call the one
  function `runCheck(entry)` of `src/credentials/check.ts`, which dispatches
  on the check's form; a test of the "Done" path with `github-app-key` set
  to a refused key resumes the stage with `done (check failed: GitHub
  refused the JWT (401))`. The `renew_credential` action (AC-14) re-runs the
  check through the same function; no catalogue entry has a renew command,
  so that path is covered by its existing test with a test entry.
- AC-6. **The earlier text is marked.** Spec 030 AC-2 and AC-4 carry the
  marks of section 4, and their earlier text follows unchanged.

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

Spec 030 AC-1, AC-3, AC-5, AC-8, AC-13 and AC-14 are not amended: they say
"the entry's check" or "the check" and apply as written to the probe. Spec
068 AC-1 is not amended: the `aws-sso` entry has a wrapper and its check
stays a command. Spec 001 section 12 is not amended: the `gh` shim and the
token refresh are untouched.

## 5. Interfaces and files

- `tools/scheduler/src/credentials/catalogue.ts`: the two forms of `check`
  and the loading rules of AC-1; `schemas/scheduler/credential-catalogue.json`:
  `check` as `oneOf` a string and `{ builtin: "github-app" | "telegram-get-me" }`.
- `tools/scheduler/src/credentials/check.ts`: `runCheck(entry, ctx)`
  dispatching on the form; the probes `github-app` (AC-2) and
  `telegram-get-me` (AC-4), each reading its secret with `readSecret`; the
  index update shared by `cred set`, `cred check`, the pre-run and the "Done"
  path (AC-5).
- `tools/scheduler/src/github/auth.ts`: `createAppClient` is reused with
  the stored key; if a helper is needed to call `GET /app` without a
  configured installation, it is added beside `botLogin()` and the existing
  functions are unchanged.
- `tools/scheduler/src/credentials/commands.ts`: `cred set` and `cred
  check` exit status and output (AC-3).
- `agents/credentials.yaml`: `github-app-key` and `telegram-bot` checks as
  `{ builtin }` (AC-1); the `github-app-key` `setup` steps end with
  `panelator-scheduler cred set github-app-key < <the .pem>` and say that the
  command prints `check ok` when the key is registered for the App.
- `tools/README.md`: the two forms of `check` and what `cred set`'s exit
  status means.
- `specs/030-beyond-github/spec.md` AC-2 and AC-4: the marks of section 4
  (AC-6).
- Tests: `tools/scheduler/test/credentials.test.ts` (AC-1 to AC-5: the
  catalogue rules, the test key and the JWT-verifying `GET /app` route, the
  `cred set` exit status, `token.json` untouched, the reasons without the
  secret), the "Done" path test in `tools/scheduler/test/driver.test.ts` or
  `e2e.test.ts` (AC-5), with the mocked route in
  `tools/scheduler/test/helpers/e2e-routes.ts` where the recorded runs need
  it.
- `docs/delivery-system-design.md`: this spec under `## Children`.

Where issue #39's implementation is not yet on `main`, these are changes to
that implementation's files as spec 030 section 5 names them, built in the
same chain or the one after; this spec adds no file spec 030 does not name.
`tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`docs/delivery-system-design.md` are sensitive paths; the security review
applies to the implementation PR (spec 006 AC-9). Nothing here changes the
sensitive-path list, the security criteria, what routes a sensitive diff to
the security review, section 3 of the design, or any text marked as a
maintainer answer. The probe adds no network listener; its one outbound call
is `GET /app` to the configured GitHub API, which the scheduler already makes
at start-up (`botLogin()`). The secret is read into memory for one probe and
is in no log line, reason string, run record or event, as spec 030 AC-1
requires; the AC-2 and AC-4 tests assert it for the failure reasons.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The AC-3 test (a key GitHub refuses makes `cred set github-app-key` exit 1
  with `last_check` failed) fails against a catalogue whose check is `gh api
  /installation/repositories --jq .total_count` with the mocked route
  answering 200, and passes with the probe. The AC-1 catalogue test fails on
  a repository catalogue whose `github-app-key` check is a string.
- A grep of `tools/scheduler/src` shows `GET /app` requested in
  `github/auth.ts` only, and `readSecret` called from `credentials/` only.
- On the laptop, after the implementation is deployed: `panelator-scheduler
  cred set github-app-key < <the current .pem>` prints `check ok` and exits
  0, and `panelator-scheduler cred check github-app-key` does the same; the
  implement stage runs them and quotes the output (without the key) in the
  PR. The failing cases are exercised only by the tests: a wrong key is not
  stored on the laptop, since spec 030 AC-3 would mint from it at the next
  refresh. The next token refresh after the `cred set` succeeds (the service
  log's refresh line).

## 7. Open decisions

None.
