# 007. Telegram channel for maintainer questions

Status: written 2026-10-27 from the delivery-system design (spec A); specs
derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 3 ("What a question looks like", "What happens while it waits"), 8
("Telegram"), 11 (row A) and 13; [process-spec](../../docs/process-spec.md)
section 6.3; [design-tree](../../docs/design-tree.md) R8.Q1; amends
[006-no-human-stops](../006-no-human-stops/spec.md) AC-13, AC-15 and AC-16
(the issue-comment channel it called interim).

What the maintainer decided (grilling, 2026-10-18 to 2026-10-20), kept as it
is here: questions reach the maintainer on Telegram; the system wakes and
responds immediately on a reply over a held-open long-poll connection, with
no polling timer and no public endpoint; a reply resumes the agent session
that asked, with its context, and it answers in the same thread within
seconds, so a decision can be a short conversation; the work stops while the
question waits; the decision is recorded in the repository; later specs use
the same channel.

## 1. Goal

Replace the interim issue-comment channel of spec 006 with Telegram as the
conversation, keeping the issue as the record:

- The scheduler holds a Telegram `getUpdates` long-poll connection open at all
  times. A message from the maintainer wakes it at once.
- A question for the maintainer (spec 006 AC-13) is sent to the maintainer's
  Telegram chat with reply buttons for its options; free text always works.
- A reply resumes the session of the stage that asked, in the same worktree,
  with its context (Claude Code `--resume`, pi's session id), and the
  conversation continues in the same Telegram thread: an acknowledgement
  within seconds, then the stage's follow-up question or its conclusion.
- The 24-hour reminder goes over Telegram.
- The issue stays the record: the question comment, the maintainer's answer
  (posted to the issue by the bot) and the recorded decision (spec 006 AC-18)
  are unchanged in substance.
- Without credentials, nothing changes: spec 006's channel stays, so the
  pipeline keeps working until the maintainer provides them.

## 2. Out of scope

- Intake and grilling over Telegram (design section 8: a later spec).
- Credential, fund and first-contact requests, security alerts and the
  notify interface's alerts (spec F2 and later): the `Notifier` keeps writing
  the service log; a later spec routes it over this channel. The question
  and reminder messages of this spec are sent by the Telegram client
  directly, not through the `Notifier`.
- The encrypted credential store and wrappers (spec F2). Here the bot token
  lives in one file outside the repository that only the scheduler process
  reads.
- The console's Questions screen (spec E) and the event store (spec D). The
  questions log gains the fields they will read.
- Group chats, forum topics and more than one maintainer: the channel is one
  private chat with one maintainer.
- Changing what a question contains or who may ask one (spec 006 AC-8,
  AC-12, AC-17) or when the work pauses (AC-13): only where it is sent and
  how the answer comes back.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001,
and a fake Telegram Bot API server (section 6). "Telegram on" means the
credentials file of AC-1 is present and valid at service start.

**Credentials and connection**

- AC-1. **Credentials live outside the repository.** `agents/scheduler.yaml`
  gains a `telegram` block: `credentials_path` (default
  `~/.config/panelator/telegram.json`) and `long_poll_timeout_s` (default
  50). The file holds `{ "bot_token": "<token>", "chat_id": <integer> }`.
  Given the file is missing or unreadable, when the service starts, then
  Telegram is off: the service log records `telegram: off` with the reason,
  once, and every behaviour of spec 006 stays as it is. Given the file is
  present but `getMe` fails with an authorization error, then the service
  starts with Telegram off and logs that once; it does not exit. The token is
  never written to the service log, a run record, a stage's environment or
  prompt, or any file in the repository; a test asserts the log and the
  stage environment after a question is sent. A `telegram` config block
  with an unknown key fails config validation (spec 001 AC-1 rules).
- AC-2. **One long-poll connection, no timer.** Given Telegram on, then the
  scheduler process keeps one `getUpdates` request open with the configured
  timeout and `allowed_updates: ["message", "callback_query"]`, and issues
  the next one as soon as the previous returns. No periodic Telegram poll
  exists; the 45-second tick stays the GitHub watchdog it is. Given a
  network or server error, then the poller retries with backoff from 1 to
  60 seconds, logs the outage once and the recovery once, and never crashes
  the service. Given the service stops, then the open request is abandoned
  and the offset of AC-3 is left as last confirmed, so nothing is lost.
- AC-3. **Updates are confirmed only after they are acted on.** The poller
  keeps `telegram/offset.json` (the next `update_id` to ask for) in the
  state directory. An update's effect (AC-7, AC-9, AC-10) is written before
  the offset moves past it, so a crash in between makes Telegram redeliver
  it, and a redelivered update is recognised by its `update_id` and does
  nothing twice. Given an update from any chat other than the configured
  `chat_id`, then it is ignored, confirmed, and logged (chat id only, no
  text) at most once per chat per service start.
- AC-4. **Setup can be checked.** `panelator-scheduler telegram-check` reads
  the credentials, calls `getMe`, sends "panelator: Telegram channel
  connected" to the chat, and prints the bot's username and the chat id, or
  the failing step. Its exit status is 0 only when the message was
  delivered. It is the step the implement stage runs after the maintainer
  provides the credentials (section 8).

**Questions over Telegram**

- AC-5. **A question is sent to the chat with buttons.** Given Telegram on
  and a pause (spec 006 AC-13), then after the question comment is posted on
  the issue (unchanged: it is the record and its id is the question id for
  marks and the log) one Telegram message is sent: a heading with the issue
  number and title, the question, the numbered options with their costs, the
  recommendation, and a link to the question comment; its reply markup is an
  inline keyboard with one button per option (callback data
  `q:<nonce>:<n>`, within Telegram's 64-byte limit). Its message id is kept
  in the paused record. The issue comment does not @-mention the maintainer
  and says the question was asked on Telegram and that a reply there or a
  comment on the issue resumes the work; with Telegram off it is the spec
  006 comment. The questions log's `sent` entry carries `channel`
  (`telegram` or `issue`) and the Telegram message id. Given sending fails
  after the comment was posted, then the pause completes as before, the
  failure is logged, and the next tick retries the send once from the record
  (the record says whether it was sent); after that the question waits on
  the issue comment and the reminder of AC-11.
- AC-6. **A crash mid-pause sends no second message.** Given a paused record
  in phase `pausing` whose Telegram message id is set, when the pause is
  completed on the next tick, then no second Telegram message is sent (the
  record is the guard, as the nonce guards the issue comment).
- AC-7. **A reply is matched to its question.** Given Telegram on and an
  update from the configured chat, then it is an answer to a question when
  it is:
  - a callback query from a question message's keyboard: the answer text is
    `<n>. <label>` of the pressed option; the callback query is answered,
    and the message's keyboard is replaced by a line naming the chosen
    option;
  - a message that replies (Telegram's reply-to) to the question message, a
    reminder or a follow-up of that question, or to any message of the bot
    in that question's thread: its text is the answer;
  - a message that replies to nothing while exactly one question is open:
    its text is the answer.

  Given a message that replies to nothing while several questions are open,
  then the bot replies listing the open questions (issue number and title)
  with one button each, and the next reply to that list, or a button press
  on it, selects the question and is answered as that question's thread
  from then on; the message that prompted the list is kept as the answer
  text once the question is chosen. Given a message when no question is
  open, then the bot replies once "No open question" (and, for `/questions`,
  the same list, or "No open question"). A message that is an answer is
  logged as `answered` with `channel: telegram`, the Telegram message id
  and the text, and the answer flow of AC-9 runs. Edited messages and
  messages from before the question was sent are ignored.
- AC-8. **A reply on the issue still resumes the work.** Given Telegram on
  and a comment by the maintainer on the issue as spec 006 AC-15 describes,
  when the tick sees it before a Telegram answer, then it resumes the work
  as today, with `channel: issue` in the log. The first answer seen wins:
  a later answer on the other channel to the same question is logged and
  ignored, and on Telegram the bot replies that the question was already
  answered, with where.
- AC-9. **A Telegram answer resumes the issue at once.** Given an answer
  matched to a question, then, in this order:
  - the bot posts the answer as a comment on the issue, headed "Answer from
    the maintainer (Telegram)", quoting the text; its comment id is the
    `reply_comment_id` of the paused record and the log, so citations and
    the resume's no-duplicate rule work as in spec 006;
  - the paused record is marked `resuming` with the answer;
  - the offset of AC-3 moves past the update;
  - the bot replies in the thread: "Got it, resuming <stage> on #<issue>."
    (within seconds: no stage runs before it is sent);
  - the loop is woken: a tick starts at once if none is in progress,
    otherwise one more runs right after the current one; the resume of spec
    006 AC-15 then takes the next free slot ahead of the shortlist.

  Given the laptop was asleep, so that the update's message date is more
  than two minutes before receipt, then the acknowledgement says instead
  "Picked up your reply from <time>; resuming <stage> on #<issue>." Given
  the scheduler stops between any two steps, then the next start finishes
  them from the record and the unconfirmed update, with no second issue
  comment (the record's `reply_comment_id` is the guard) and no second
  acknowledgement.
- AC-10. **The conversation continues in the thread.** Given the resumed
  stage returns a follow-up (spec 006 AC-15, `follow_up: true`), then the
  new question is sent as a reply to the maintainer's last message in the
  thread, with buttons when it has options, and the issue comment is posted
  as the record, as in AC-5. Given the resumed stage returns anything else,
  then the bot replies in the thread with one line: for a spec stage, "Done:
  recorded in <PR link>"; for any other stage, "Done: continuing with your
  answer"; for a failed run, "The <stage> run failed; the chain retries"
  (the retry rules of spec 006 are unchanged). No agent text other than a
  question is forwarded to Telegram.
- AC-11. **The reminder goes over Telegram.** Given Telegram on and a
  question unanswered for 24 hours (spec 006 AC-16), then the one reminder
  is a Telegram reply to the question message, with the buttons again; no
  reminder comment is posted on the issue, the log's `reminded` entry
  carries `channel: telegram`, and the `Notifier` call of AC-16 stays.
  Given Telegram off, the reminder is the spec 006 comment. Given a question
  that was sent before this spec's service started (an issue-comment
  question with no Telegram message), then it is handled as Telegram off
  until it is answered.

**Resuming the session that asked**

- AC-12. **The asking session is recorded.** Given a question raised by an
  agent stage's result, then the paused record gains `session`: the run's
  harness, model and session id, and its worktree. The question check's
  session is never recorded (it is independent and does not resume). Given a
  question from verify (spec 006 AC-17), then `session` is null.
- AC-13. **The reply resumes that session when the chain returns to the
  asking stage.** Given a reply whose spec 006 section 4 row runs the asking
  stage again (a spec question; a capability question; a technical question
  asked by fix) and a recorded `session`, then the stage runs as a
  continuation of that session: the Claude adapter builds
  `claude -p <reply prompt> --resume <session id>` without `--session-id`,
  the pi adapter reopens the session by its id (the plan confirms the flag
  against the installed pi), and the same worktree is used. The reply prompt
  is short: the answer with its `Question #<id>: ` prefix (both answers for
  a follow-up), the mode the stage is in, and the new run's result path,
  which the run's permissions allow as for any run. The run has the stage
  definition's bounds afresh and its own run id and usage record, which
  names the resumed session id. Given the row runs a different stage
  (`record` mode after a product or technical question from plan,
  implement or review; a fix after a review's technical question), then it
  runs fresh, as spec 006 says.
- AC-14. **A session that cannot be resumed falls back to a fresh one.**
  Given the resume fails before any agent turn (the harness exits with an
  error naming the session, or no init event appears), then one fresh
  session runs with the spec 006 input (the question and the reply) in the
  same attempt; this fallback is logged in the run record and is not a
  failed run. Given the resume fails after an agent turn, then it is a
  failed run as today. Given the recorded session's harness is not the
  stage's current harness (a fallback model answered the original run), then
  the stage runs fresh without trying.
- AC-15. **Decide mode and the bounds are unchanged.** A resumed run is
  judged, bounded and counted exactly as a fresh run of the stage: the
  result schema, the follow-up rules, decide mode, the retry and escalation
  counts of spec 006. The recorded end-to-end chains of spec 006 AC-28 that
  answer a question pass unchanged with Telegram off.

## 4. Design notes (agent's calls)

- **In the scheduler process, not a companion service.** Design section 13
  leaves this to the builder. The scheduler is already the persistent
  systemd user service process-spec 6.3 asks for, holds the sleep inhibit,
  owns the paused records and the loop that resumes them, and the design
  says nothing connects in to the laptop. A companion service would need its
  own state and an IPC path to wake the loop; a held-open request inside the
  process is a few hundred lines and is not a poll inside a tick. It is
  cheap to split out later; no ADR.
- **Both channels answer.** A comment on the issue keeps resuming the work
  (AC-8) because the record's reply path costs nothing to keep and the
  maintainer at the desk may answer there.
- **The acknowledgement is the scheduler's, the substance is the agent's.**
  "Within seconds" is met by the acknowledgement; the agent's own next word
  is its follow-up, which the resumed session produces faster than a fresh
  one because the context is already loaded.
- **No `Notifier` changes.** The channel is used directly for questions and
  reminders; routing alerts is spec F2's, as the issue says.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/`:
  - `client.ts`: the Bot API over `fetch` (`getMe`, `getUpdates`,
    `sendMessage`, `editMessageReplyMarkup`, `answerCallbackQuery`), base
    URL injectable for the fake server;
  - `poller.ts`: the long-poll loop of AC-2, the offset of AC-3, backoff,
    and the `onUpdate` hook that wakes the loop;
  - `questions.ts`: message formats and keyboards (AC-5, AC-10, AC-11), the
    matching of AC-7, the `/questions` list;
  - `credentials.ts`: the credentials file of AC-1.
- `tools/scheduler/src/service/loop.ts`: `wake()`; the Telegram answer in a
  record marked `resuming` goes through `#resume`; the reminder of AC-11;
  the retry of a failed send (AC-5); the "Done" line of AC-10 after a
  resumed run.
- `tools/scheduler/src/chain/driver.ts`: `completePause` sends the Telegram
  message after the comment and records its id (AC-5, AC-6); the pause
  records the asking run's session (AC-12); the resume passes `resume` to
  the runner when AC-13 applies and posts nothing itself.
- `tools/scheduler/src/chain/question.ts`: the comment variant of AC-5.
- `tools/scheduler/src/adapters/types.ts`: `StageRun.resume?: { sessionId }`;
  `claude.ts`, `pi.ts`, `fake.ts`: the resumed command (AC-13); the fake
  adapter records the request so tests can assert it.
- `tools/scheduler/src/runner/run.ts`: the fresh-session fallback of AC-14;
  the usage record's resumed session id.
- `tools/scheduler/src/stages/prompt.ts`: the reply prompt of AC-13.
- `tools/scheduler/src/state/paused.ts`: `session`, `telegram`
  (`message_id`, `sent`, `thread_last_message_id`); `pausedDecision`
  unchanged for the issue path. `tools/scheduler/src/state/paths.ts`:
  `telegram/offset.json`. `tools/scheduler/src/state/questions.ts`: the
  `channel` and `telegram_message_id` fields.
- `tools/scheduler/src/config.ts` and `agents/scheduler.yaml`: the
  `telegram` block (AC-1).
- `tools/scheduler/bin/scheduler.ts`: start the poller with the service;
  the `telegram-check` command (AC-4).
- `schemas/scheduler/paused.json`, `question-log-entry.json`,
  `usage-record.json`: the new optional fields above.
- `agents/stages/plan.md`, `implement.md`, `fix.md`, `spec.md`: one
  paragraph saying a resumed session continues from where it asked, with
  the reply as the next message, and writes its result to the new path.
- `tools/scheduler/test/`: `telegram.test.ts` (client, poller, offset,
  matching, formats, against the fake server), `adapters-claude.test.ts` and
  `adapters-pi.test.ts` (the resumed command), `run.test.ts` (AC-14),
  `loop.test.ts` and `driver.test.ts` (AC-5 to AC-11), `config.test.ts`
  (AC-1), and the recorded chains of section 6 in `e2e.test.ts`; the fake
  Telegram server under `test/helpers/`.
- `tools/scheduler/systemd/panelator-scheduler.service`: unchanged (same
  process).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed. `tools/scheduler/` and `agents/` are sensitive
paths, so the security review runs on the PR as spec 006 AC-9 says.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including recorded end-to-end chains (fake adapter, mocked GitHub, fake
  Telegram server) for:
  - a question sent to Telegram, answered by a button, the asking session
    resumed with `--resume`, the answer recorded and merged;
  - a question answered by free text while two questions are open: the
    list, the choice, the resume;
  - a follow-up conversation: reply, follow-up in the thread, second reply,
    recorded and merged;
  - a reply received after the laptop slept: the "picked up" acknowledgement;
  - a reminder over Telegram, then an answer on the issue comment (AC-8);
  - a resume that fails before any turn, the fresh-session fallback, merged;
  - a crash after the issue comment and before the offset moved: redelivery
    does nothing twice;
  - Telegram off: every spec 006 AC-28 chain unchanged.
- With the credentials in place (section 8), `panelator-scheduler
  telegram-check` delivers the test message; the implement stage runs it and
  quotes its output in the PR.
- After the service is restarted on the merged code, the first real question
  answered over Telegram is written up in `dev-logs/` with its run records,
  the Telegram message ids and the time from reply to acknowledgement.

## 7. Open decisions

None.

## 8. Setup the maintainer does (the capability this spec needs)

The bot token and the chat id are a credential the maintainer must provide
(design section 3, item 3). The implement stage raises it as a question of
kind `capability` through the question check, with these steps copied in,
when it reaches the verification step of section 6 and the credentials file
is absent; until then it builds and tests against the fake server, and the
service runs with Telegram off. The steps:

1. In Telegram, open `@BotFather`, send `/newbot`, choose a display name
   (for example "panelator") and a username ending in `bot`. Copy the token
   BotFather returns.
2. Open a chat with the new bot and send `/start`, so the bot may message
   you (a bot cannot open a private chat itself).
3. Find the chat id: run
   `curl -s "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[-1].message.chat.id'`
   right after step 2 (or send any message to `@userinfobot` and read the
   id it returns).
4. Write `~/.config/panelator/telegram.json` on the laptop:
   `{ "bot_token": "<token>", "chat_id": <id> }`, then
   `chmod 600 ~/.config/panelator/telegram.json`.
5. Run `panelator-scheduler telegram-check` from the repository (or restart
   the service: `systemctl --user restart panelator-scheduler`); the bot
   sends "panelator: Telegram channel connected" and the service log shows
   `telegram: connected as @<username>`.

The answer to that question is "done" (or the failing step); nothing is
recorded in the repository for it beyond the questions log (spec 006 AC-18).
