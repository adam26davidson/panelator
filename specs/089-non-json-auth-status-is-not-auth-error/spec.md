# 089. A 401 or 404 whose body is not a Bot API error does not turn Telegram off

Status: written 2026-11-19 from the delivery-system design for issue #186;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram": the scheduler holds a long-poll connection open at all
times) and section 10 ("Small work skips layers": a bug spec hangs directly
off a top design); [design-tree](../../docs/design-tree.md) R8.Q1 (a
persistent long-poller on the laptop is what makes the channel immediate);
[043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
AC-1 (a `getMe` failure that is not an authorization error is retried as
`telegram: connecting`) and AC-2 (an authorization error is "a Bot API error
with code 401 or 404" and turns Telegram off for the service's life), which
this spec brings the code in line with and does not change;
[007-telegram-channel](../007-telegram-channel/spec.md) AC-1 (only an
authorization error turns Telegram off). No earlier spec's text is marked:
the code is wrong against spec 043 AC-2 as written.

## 1. Goal

Only a response that is a Bot API error object with code 401 or 404 counts
as an authorization error. A 401 or 404 from something that is not the Bot
API (a captive portal, a reverse proxy, an HTML error page) is a connection
failure: the poller's connect step logs `telegram: connecting` and retries,
and Telegram comes on when the Bot API answers.

### What is wrong today

`TelegramClient.call` (`tools/scheduler/src/telegram/client.ts`) throws
`TelegramApiError(response.status, "invalid response")` when the body does
not parse as JSON, and `TelegramApiError(data.error_code ?? response.status,
...)` when a JSON body has no `error_code`. `isAuthError` accepts any
`TelegramApiError` whose code is 401 or 404. So an HTML 404 from a captive
portal answering `getMe` is classified as an authorization error: the
poller writes `{ kind: "telegram", status: "off", reason: "getMe:
unauthorized" }` and ends its loop (spec 043 AC-2), and Telegram stays off
until the service restarts, although the token is valid and the next
request through a working network would succeed. The Bot API's own 401 and
404 (bad or malformed token) are JSON bodies `{"ok":false,"error_code":...,
"description":...}`; a body of any other shape did not come from the Bot
API.

### The fix

`TelegramApiError` records whether the error came from a Bot API error
object, and `isAuthError` requires it. *(agent's call)* A boolean field on
the existing class, rather than a subclass, keeps every `instanceof
TelegramApiError` check and the error message as they are; the field is set
in the one place that sees the body. A thrown `fetch` (code 0) is already a
connection failure and is unchanged. The change is a field and a condition,
cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- The credentials store's `telegram-get-me` check probe
  (`tools/scheduler/src/credentials/check.ts`, spec 069 AC-5): it reports `unauthorized` for any
  `TelegramApiError` with code 401. It reports and does not turn anything
  off; aligning its wording is a separate change.
- `telegram-check` (spec 007 AC-4): unchanged, it reports `getMe: failed`
  for any failure.
- A `getUpdates` or `sendMessage` error after the connection is made: as
  spec 043 section 2 says, those are outages or failed sends whatever their
  code; this spec changes nothing there.
- Which Bot API codes are authorization errors: 401 and 404 stay, as spec
  043 AC-2 says.
- The error message and `description` of a `TelegramApiError`, and the
  token redaction in it: unchanged.

## 3. Acceptance criteria

"Given" states use the fake Telegram Bot API server of spec 007 section 6
(`tools/scheduler/test/helpers/fake-telegram.ts`), extended as section 5
says. A *Bot API error object* is a response body that parses as a JSON
object whose `ok` is `false` and whose `error_code` is a number.

- AC-1. **The client marks Bot API errors.** Given a request whose response
  body is a Bot API error object, when `TelegramClient.call` rejects, then
  the `TelegramApiError` has `error_code` equal to the body's `error_code`
  and `bot_api: true`. Given any other failed response, then the
  `TelegramApiError` has `bot_api: false`: a body that does not parse as
  JSON, or that parses to something other than a JSON object (`null`, a
  number, an array, a string), rejects with `error_code` equal to the HTTP
  status and description `invalid response`; a JSON object that is not a
  Bot API error object but whose HTTP status or `ok` says the request
  failed rejects with `error_code` equal to the HTTP status, as today. A
  thrown `fetch` rejects with code 0, `connection failed` and `bot_api:
  false`, as today. A successful response (HTTP 2xx and `ok: true`) still
  resolves to `result`.
- AC-2. **Only a Bot API 401 or 404 is an authorization error.** Given a
  `TelegramApiError`, then `isAuthError` returns true exactly when
  `bot_api` is true and `error_code` is 401 or 404. Given an HTML (non-JSON)
  body with HTTP status 401 or 404, or a JSON object without `error_code`
  with HTTP status 401 or 404, then `isAuthError` of the rejection is
  false. A Bot API error object with `error_code` 401 or 404 is an
  authorization error, whatever the HTTP status.
- AC-3. **The connect step retries a non-Bot-API 401 or 404.** Given the
  poller's connect step (spec 043 AC-1) and `getMe` answered with an HTML
  body and HTTP status 404, then 401, then success, when the poller starts,
  then it writes `{ kind: "telegram", status: "connecting", reason: "getMe:
  connection failed" }` once, waits 1000 then 2000 ms, writes the
  `connected` line with the bot's username, calls the attach hook once and
  issues its first `getUpdates`; it writes no `off` line. Given `getMe`
  answered with a Bot API error object with `error_code` 401 (or 404), then
  the poller writes the `off` line and issues no `getUpdates`, as spec 043
  AC-2 says (the existing test keeps passing).

## 4. Amendments to earlier specs

None. Spec 043 AC-2 already defines an authorization error as "a Bot API
error with code 401 or 404"; this spec makes `isAuthError` match it.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/client.ts`: `TelegramApiError` gains a
  read-only `bot_api: boolean`, passed as an optional third constructor
  argument defaulting to `false` (existing `new TelegramApiError(code,
  description)` call sites keep compiling). `call` parses the body; a
  parse failure or a non-object value throws `TelegramApiError(status,
  "invalid response", false)`; an object that is a Bot API error object
  throws with its `error_code`, its redacted `description` and `true`; any
  other failed response throws with the HTTP status and `false`.
  `isAuthError` requires `e.bot_api` as well as the code.
- `tools/scheduler/test/helpers/fake-telegram.ts`: `fail` gains an optional
  fourth argument, a raw body string sent instead of the Bot API error
  object (with `content-type: text/html`), so a test can answer a method
  with an HTML 404; existing calls are unchanged.
- `tools/scheduler/test/telegram.test.ts`: tests for AC-1 and AC-2 (beside
  "client sends and sanitizes errors": a Bot API 401 and 404 are
  `bot_api: true` and auth errors; an HTML 401 and 404, a JSON `{}` with
  status 404 and a JSON `null` body are `bot_api: false`, not auth errors,
  and do not contain the token) and AC-3 (in the connect-step `describe`,
  using its `rig`: HTML 404 then HTML 401 then success gives the
  `connecting` line, waits `[1000, 2000]`, the `connected` line and no
  `off` line).

No file outside `tools/scheduler/` and `specs/` is changed. `tools/scheduler/`
is a sensitive path, so the security review runs on the implementation PR as
spec 006 AC-9 says. No schema, config key, stage prompt, log record or state
file format changes.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  with the tests of section 5 added and spec 043's connect-step tests
  passing unchanged.
- A grep of `tools/scheduler/src/telegram/client.ts` shows `isAuthError`
  reading `bot_api`.

## 7. Open decisions

None.
