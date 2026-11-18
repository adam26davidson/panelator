# 072. A plain credential file left after its import reaches the maintainer as a weekly reminder, not as a finding

Status: written 2026-11-18 from the delivery-system design for issue #139;
specs derived from that design need no maintainer approval (design section 11).
Amends [030-beyond-github](../030-beyond-github/spec.md) AC-4 (the credential
check files no finding for a plain file) and AC-13 (the credential check's
input has no plain-file list and its result no plain-file finding);
[069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
AC-10 (what `cred import` prints about the two files); and
[007-telegram-channel](../007-telegram-channel/spec.md) AC-1 (the Telegram
credentials are read from the store once `telegram-bot` is set). Each is marked
as section 4 records. The issue says it depends on issue #39 (PR #128); that PR
closed unmerged and #39 is abandoned, so this spec builds on what `main` has
(section 1, "How this reaches `main`"). *(agent's call)*
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Credentials": kept in an encrypted store on the laptop; "Telegram
carries questions, credential and fund requests, first-contact requests, alerts
and reminders"), section 3 item 3 (credentials and access are what only the
maintainer can do), section 10 ("Small work skips layers") and section 11 (row
F2); [030-beyond-github](../030-beyond-github/spec.md) AC-1 (the store and its
index), AC-4 (`cred import` and the plain files it leaves), AC-13 (the
credential check, amended here); [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
AC-9 (the App key is read from the store once `github-app-key` is set) and
AC-10 (`cred import`, amended here), and its section 2 (the Telegram poller
reading `telegram-bot` from the store is left to a later spec);
[007-telegram-channel](../007-telegram-channel/spec.md) AC-1 (the credentials
file, amended here) and AC-2 ("Telegram on");
[043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
AC-1 (the `getMe` connect step); [026](../026-event-store/spec.md) AC-2 as
built in `src/notify/recorded.ts` (a notification is a `maintainer.contact`).

## 1. Goal

After `cred import`, the two plaintext originals (`app.private_key_path` and
`telegram.credentials_path`) are deleted by hand, and only the maintainer does
that. Once the running service reads a credential from the store, the scheduler
tells the maintainer on Telegram that its plain file can go: one message naming
every such file, repeated at most weekly while one remains, and nothing once
they are gone. No queue issue and no daily finding carries it.

### What is wrong today

Spec 030 AC-4 and AC-13 make the plain file a finding of the daily credential
check. A finding goes to the filer and becomes an ordinary issue in the queue
that no agent can resolve (deleting a secret file on the maintainer's laptop is
the maintainer's step) and that the next day's run files again. A reminder to
the maintainer is what the design's Telegram channel carries (section 8).

Two facts on `main` also stand in the way of deleting either file safely:

- the `.pem` is safe once the service has restarted after the import, because
  `appPrivateKey` (spec 069 AC-9) reads the store when the index holds
  `github-app-key`; the comment on PR #128 about `bin/scheduler.ts` reading the
  `.pem` directly is about that closed branch, and `main` already reads the
  store;
- the Telegram file is not safe: `startTelegram` and `telegramCheck`
  (`src/service/telegram-start.ts`) read `telegram.credentials_path` always,
  and `cred import` says so ("still read by the Telegram poller until a later
  spec moves it"). Deleting it turns Telegram off, and with it the reminder.
  This spec is that later spec: without it the Telegram file could never be
  named. *(agent's call)*

### How this reaches `main`

*(agent's call)* The credential check agent, its input builder
(`credential-check-input.ts`) and its prompt, which the issue names, exist only
on the closed branch of issue #39. `main` has the store, the index, the
catalogue and the `cred` commands (spec 069), the notifier chain
(`rateLimited(recordedNotifier(LogNotifier))`) and the Telegram channel the
question reminders use (`SchedulerDeps.telegram`). The reminder is built on
those, in the scheduler's tick, the way the disk sweep of spec 064 is: it is a
deterministic check of two paths and the index, so no agent is needed, and the
credential check, whenever it is built, is told by the marks of section 4 not to
carry plain files at all.

## 2. Out of scope

- Building any other part of spec 030: the credential check agent, the
  `TelegramNotifier` of AC-9 (every notification on Telegram), the shims and
  `cred exec`. When spec 030 AC-9 is built, the notifier carries every
  notification to Telegram, so the chain that builds it drops AC-4's direct
  Telegram send, which exists only because the notifier on `main` writes to
  the service log alone. *(agent's call)*
- Deleting the files, or checking that a file's content equals the stored
  secret. The scheduler never deletes a maintainer's file; a file at a
  configured path whose credential the service reads from the store is
  unread plaintext whatever it holds.
- The `aws-sso` entry (spec 068): it has no plain file of its own.
- Files outside the two configuration paths.
- Recording the channel in the `maintainer.contact` event (spec 068 AC-4);
  the notifier records what it records today.

## 3. Acceptance criteria

"Given" states use spec 069 section 3's fakes: the fake `systemd-creds` of
`test/helpers/fake-systemd-creds`, a temporary state directory and a temporary
credentials directory, a fake Telegram channel recording what it sends, a fake
notifier recording what it is given, and an injected clock.

- AC-1. **The Telegram credentials are read from the store once set.** Given
  the index holds `telegram-bot`, when the service starts (`startTelegram`) or
  the maintainer runs `panelator-scheduler telegram-check` (`telegramCheck`),
  then the credentials are the decrypted `telegram-bot` secret, parsed and
  validated with the same shape rule as the file (`bot_token` a non-empty
  string, `chat_id` a safe integer), and `telegram.credentials_path` is not
  read: a test deletes the file and Telegram still starts. Given the secret
  cannot be decrypted or has the wrong shape, then Telegram is off with the
  reason `stored telegram-bot credential unreadable` or `stored telegram-bot
  credential has an invalid shape`, logged once as today; it does not fall
  back to the file (as the App key does not, spec 069 AC-9), and no reason
  carries text of the secret or of a parser error. Given the index does not
  hold `telegram-bot`, then the file is read exactly as spec 007 AC-1 says.
- AC-2. **The service knows which credentials it runs on from the store.**
  At start, `bin/scheduler.ts` records the set of the two credentials it read
  from the store, from the same index read that chose each source:
  `github-app-key` when `appPrivateKey` returned the stored key,
  `telegram-bot` when AC-1 read the stored secret and its shape was valid. The
  set is fixed for the life of the process and passed to the scheduler as
  `SchedulerDeps.plainFiles` (section 5). A process that read a credential
  from its file never names that file, even after a later `cred import` or
  `cred set`, until it has restarted (the issue's "the service has restarted
  since").
- AC-3. **A file is named when it is unread plaintext.** At most once an
  hour, the first time on the first tick after the service starts, the
  scheduler computes the named files: for each of `github-app-key`
  (`app.private_key_path`) and `telegram-bot` (`telegram.credentials_path`),
  the path is named when the credential is in AC-2's set, the index still
  holds its entry at the time of the check, and a file (of any kind but a
  directory) exists at the path. Given the index no longer holds the entry
  (`cred remove`), then the file is not named, because the next restart reads
  it again. A failure of the check (index unreadable, a `stat` error other
  than not-found) is logged as `{ kind: "plain-files-check-failed", error }`
  and never stops the tick; the next check is an hour later.
- AC-4. **One message, at most weekly, naming every file.** Given the named
  files are not empty, then a reminder is sent when the state file
  `plain-files-reminder.json` (section 5) is absent, or names a file list
  that lacks one of the named files, or its `sent_at` is 7 days or more
  before now; otherwise nothing is sent. A reminder is:
  - when Telegram is on (`SchedulerDeps.telegram` set), one Telegram message
    through `telegram.sendReply(text)` with no reply target and no keyboard;
  - then, in both cases, one notification `{ issue: 0, gate: "credential",
    label: "plain-files", text }` through the scheduler's notifier, which
    writes the service log line and the `maintainer.contact` event as every
    notification does;
  - then the state file is written as `{ sent_at, files }` with the named
    files.

  The text is `panelator: these plaintext credential files are no longer read
  (the service reads them from the encrypted store) and can be deleted:`
  followed by one line per file, `- <path> (<credential name>)`, and the line
  `Delete them by hand; this reminder repeats weekly while one remains.`
  Given the Telegram send fails, then `{ kind: "plain-files-reminder-failed",
  error }` is logged, neither the notification nor the state file is written,
  and the next hourly check tries again. The state file survives a restart,
  so a restart within the week sends nothing.
- AC-5. **Nothing once the files are gone.** Given the named files are empty
  (both deleted, or neither credential read from the store), then nothing is
  sent and the state file, if present, is removed, so a file that later
  reappears at a configured path is named again in a first message.
- AC-6. **No queue issue and no finding carries a plain file.** Nothing on
  `main` files a finding or an issue for a plain file: a test runs a check
  with both files named and asserts the findings queue
  (`paths.findingsQueue`) and the GitHub fake received nothing. Spec 030 AC-4
  and AC-13 carry the marks of section 4, so the credential check, when it is
  built, has no plain-file input and files no plain-file finding.
- AC-7. **`cred import` prints what this spec makes true.** `cred import`
  prints, after its per-credential lines, one line per file:
  `<path>: safe to delete after the service has restarted; the scheduler
  reminds you while it remains`, for `app.private_key_path` and for
  `telegram.credentials_path`. The line "still read by the Telegram poller
  until a later spec moves it" is gone.
- AC-8. **The earlier text is marked.** Spec 030 AC-4 and AC-13, spec 069
  AC-10 and spec 007 AC-1 carry the marks of section 4, prepended after the
  existing marks and before the bold title, with the earlier text unchanged
  after them.

## 4. Amendments to earlier specs

Each mark reads `Amended by [072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md) AC-k:`
followed by the clause below, prepended after the unit's existing marks and
before its bold title:

- [030-beyond-github](../030-beyond-github/spec.md) AC-4, with AC-4: a plain
  file still present after the service reads its credential from the store is
  a weekly reminder the scheduler sends the maintainer, not a finding of the
  credential check.
- [030-beyond-github](../030-beyond-github/spec.md) AC-13, with AC-6: the
  credential check's input has no plain configuration files and its result
  files no finding for a plain file.
- [069-github-app-key-check-signs-with-the-stored-key](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
  AC-10, with AC-7: `cred import` prints both files as safe to delete after
  the service has restarted, with the scheduler reminding the maintainer while
  one remains.
- [007-telegram-channel](../007-telegram-channel/spec.md) AC-1, with AC-1:
  once the index holds `telegram-bot`, the credentials are the stored secret
  and the file is not read.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/credentials.ts`: `telegramCredentials(path,
  store)` returns `{ bot_token, chat_id, source: "store" | "file" }` or
  `{ off: reason }` as AC-1 says; `readTelegramCredentials(path)` stays the
  file half, and the shape check is shared.
- `tools/scheduler/src/service/telegram-start.ts`: `startTelegram(cfg, store,
  log, baseUrl?)` and `telegramCheck(cfg, store, baseUrl?)` read through
  `telegramCredentials`; `startTelegram` also returns the source.
- `tools/scheduler/src/credentials/store.ts`: `appPrivateKey` reports its
  source beside the key (a second exported function or a returned object; the
  existing callers keep a string).
- `tools/scheduler/src/credentials/plain-files.ts` (new):
  `checkPlainFiles(deps)`, where deps are the store, the two
  name-to-path pairs, AC-2's set, the state path, the Telegram channel or
  `null`, the notifier, `now` and `log`; it computes the named files (AC-3)
  and sends, records or clears (AC-4, AC-5). The text of AC-4 is built here.
- `tools/scheduler/src/state/paths.ts`: `plainFilesReminder:
  join(root, "plain-files-reminder.json")`.
- `tools/scheduler/src/service/loop.ts`: `SchedulerDeps.plainFiles?: {
  store: CredentialStore; paths: Record<"github-app-key" | "telegram-bot",
  string>; fromStore: ReadonlySet<string> }`; the tick calls
  `checkPlainFiles` at most hourly (an in-memory last-check time) beside the
  disk sweep, a failure caught as AC-3 says. Absent `plainFiles`, the step is
  skipped (the existing loop tests).
- `tools/scheduler/bin/scheduler.ts`: passes the store to `startTelegram` and
  `telegramCheck`, builds AC-2's set from the two sources, and passes
  `plainFiles` to the `Scheduler`.
- `tools/scheduler/src/credentials/commands.ts`: the `cred import` lines of
  AC-7.
- Tests: `tools/scheduler/test/plain-files.test.ts` (new; AC-3 to AC-6),
  `tools/scheduler/test/telegram.test.ts` (AC-1),
  `tools/scheduler/test/credentials.test.ts` (AC-2's source reporting, AC-7),
  `tools/scheduler/test/loop.test.ts` (the hourly call and that a failure
  does not stop the tick).
- The four marked specs (section 4) and the `## Children` section of
  `docs/delivery-system-design.md`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths,
listed here so the scope gate accepts them, and the security review runs.
`agents/sensitive-paths.txt`, the gates and the review criteria are unchanged,
and no schema or agent file changes.

## 6. Verification

`pnpm test` from the repository root, which runs the tests of section 5:

- AC-1: with the index holding `telegram-bot` and the file deleted,
  `startTelegram` returns a channel built from the stored token; with a
  corrupt blob (the fake `systemd-creds` failing as asked) it returns off with
  the AC-1 reason and the log line carries no token; without the entry the
  file is read.
- AC-2 to AC-5, with an injected clock: a set holding both credentials and
  both files present sends one Telegram message and one notification naming
  both, and writes the state file; a second check at +1 hour and one after a
  simulated restart (a new `checkPlainFiles` over the same state file) send
  nothing; one at +7 days sends again; deleting one file and checking at +8
  days names only the other; deleting both removes the state file and sends
  nothing; a set without `telegram-bot` never names its file; an entry removed
  from the index is not named; a failing Telegram send leaves no state file
  and no notification, and the next check sends.
- AC-6: the findings queue and the GitHub fake are empty after those checks.
- AC-7: the `cred import` output holds the two lines and not the old one.

On the laptop, after this merges and the service restarts on `main` with both
credentials imported (the maintainer did so on 2026-11-05): the Telegram chat
receives one message naming the `.pem` and `telegram.json`; after both are
deleted, `plain-files-reminder.json` is gone from the state directory and no
further message comes, and Telegram keeps working across the next restart.

## 7. Open decisions

None.
