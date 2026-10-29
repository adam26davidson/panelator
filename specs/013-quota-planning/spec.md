# 013. Subscription quota is a planned resource

Status: written 2026-10-29 from the delivery-system design for issue #24;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Token spend is bounded by the maintainer's Anthropic and OpenAI
subscriptions") and section 6.1; [process-spec](../../docs/process-spec.md)
6.5 (model tiering, cost-capped fallback on rate limits);
[ADR 0001](../../docs/decisions/0001-harness-per-model-vendor.md) (OpenAI
models as fallback when Claude quota runs out); research
[05-token-efficiency](../../docs/research/05-token-efficiency.md) findings 8
and 9 and [08-synthesis](../../docs/research/08-synthesis.md) item 16
(quota-aware scheduler state). Amends
[001-scheduler-core](../001-scheduler-core/spec.md) AC-25 (a strong-tier
stage may move to the next-best Claude model on a model-specific limit) and
the postponement wait of AC-25 and spec 006 AC-26/AC-27 (the wait ends at the
stated reset, not after a fixed 30 minutes).

## 1. Goal

The Claude subscription's limits are a known, recurring constraint, but the
scheduler meets them as surprises. Observed 2026-10-27 to 2026-10-29 in the
live state directory:

- About 1,280 `findings-filer` runs, nearly all failing within 3 seconds
  with 429 and `You've hit your session limit · resets 8:10am
  (Europe/Berlin)` or `You've reached your Fable limit. Switch to another
  model, ...`. The filer retried about every 56 seconds for hours instead of
  waiting for the stated reset (issue #24): a failed standing run leaves its
  pending events, so the next tick runs it again.
- Strong-tier chain stages postponed for a fixed 30 minutes and retried, each
  retry another 3-second 429, about ten times per window.
- Session windows are five hours long and, with the pipeline always busy,
  start at the first run after a reset. Each held about $31 to $48 of
  reported run cost before the limit was hit; the run that was running when
  the limit hit (for example a $3.96 review at 12:59Z, a $3.59 filer run at
  02:58Z) was lost.
- After the Fable limit, every strong-tier stage idled although Claude Opus
  still worked.

After this spec the scheduler keeps a quota book: what each limit message
says, when it resets, how much a window holds, and what each stage usually
costs. Nothing that needs a limited provider or model is launched before the
reset; a strong-tier stage that would likely be cut off near the end of a
window waits for the reset instead of wasting the run; a strong-tier stage
whose model alone is limited runs on the next-best Claude model; and the
book's state is visible in the service log and on the command line.

## 2. Out of scope

- Standing agents starving behind claims (issue #23) and slot counting
  (spec 009, other specs in flight). This spec does not change how many
  runs start in a tick, only whether a given run may start and on which
  model.
- Losing work across a postponed retry (issue #35, patches dropped on a
  postponed retry); a separate change.
- The console's display of the quota book (spec E). Until the console
  exists, the parameters are listed by `scheduler param list` and the book
  by `scheduler quota`; the console spec picks both up from the parameter
  store and `quota.json`.
- Reading quota from a provider API. The book is built only from what runs
  report: limit messages, API status and the cost in each usage record.
- OpenAI limit messages. A pi run's 429 is recorded per model with backoff
  (AC-3); pi reports no reset time today.

## 3. Acceptance criteria

Definitions. A *limit* has a key, a scope, a reset instant, the message it
came from, and a source (`stated` when the message names the reset, else
`backoff`). Keys: `claude` for a Claude session or weekly limit (all Claude
models), `claude:<family>` for a Claude model limit (`fable`, `opus`,
`sonnet`, from the message, matched against model ids containing
`-<family>-`), and `<harness>:<model>` for a 429 whose message is not
recognised. A model is *blocked* while a limit whose key covers it has a
reset instant in the future. The book lives in `quota.json` in the state
directory, written under the state lock.

**Parsing**

- AC-1. Given `You've hit your session limit · resets 8:10am
  (Europe/Berlin)` at 2026-10-29T02:58Z, then the limit is key `claude`,
  scope `session`, reset 2026-10-29T07:10Z (the next 8:10 in that zone
  after now, with the zone's offset on that date), source `stated`. Given a
  time already past today in that zone, the reset is the same time
  tomorrow. Times with no minutes (`resets 3am`), 24-hour times (`resets
  15:10`) and a leading month and day (`resets Nov 3, 9am`, the next such
  date) parse the same way; `weekly limit` gives scope `weekly`, key
  `claude`.
- AC-2. Given `You've reached your Fable limit. Switch to another model,
  ...`, then the limit is key `claude:fable`, scope `model`, source
  `backoff`. Given `You've hit your Opus limit · resets 9pm (UTC)`, then key
  `claude:opus`, scope `model`, source `stated`.
- AC-3. Given a 429 whose reason is not recognised, an unknown time zone, or
  an unparseable time, then the limit is key `<harness>:<model>` (or the
  recognised key) with source `backoff`: the reset is now plus 15 minutes
  for the first consecutive hit of that key, doubling for each further hit,
  at most 4 hours. A run of a model covered by the key that ends `ok`
  clears the key's backoff count. *(agent's call: 15 minutes to 4 hours;
  a probe that fails costs about 3 seconds and nothing)*

**One wake per limit (issue #24)**

- AC-4. Given any run (chain stage or standing agent) ends with API status
  429, then its limit is recorded in the book and one `quota-limit` line is
  written to the service log with key, scope, reset, source and the run id.
- AC-5. Given a chain stage hits 429 and is postponed (spec 001 AC-25, spec
  006 AC-26/27), then the claim's `postponedUntil` is the reset instant of
  the limit that blocks the stage's model, not the fixed `POSTPONE_WAIT_S`,
  and no run of that stage starts before it. Given a postponed claim whose
  `postponedUntil` is in the future, then the liveness step does not expire
  it (the wait is scheduled, not stalled).
- AC-6. Given a chain stage is about to start and its model is blocked (and
  AC-9 offers no other model), then no run is started, no run directory or
  usage record is created, the chain is postponed to the reset as in AC-5,
  and a `quota-wait` line is logged with issue, stage, model, key and
  reset.
- AC-7. Given a standing agent's run hits 429, or its model is blocked when
  it is due, then the agent's state gets `postponed_until` set to the reset,
  its `failures` count is unchanged, its pending events are kept, no
  failure finding or notification is raised, and the tick does not start it
  again before `postponed_until`, whatever events (such as `finding_queued`)
  arrive meanwhile. (The live loop fed itself: each second 429 wrote a
  failure finding, whose `finding_queued` event made the filer due again.) A blocked agent starts no run at all.
  Given a tick after `postponed_until`, then it is started as usual and
  `postponed_until` is cleared when it starts.

**Planning around the window**

- AC-8. Window and estimates. The book keeps, for the Claude provider, the
  current session window: it starts at the first Claude run started at or
  after the previous window's end and ends `quota.session_window` (default
  5h) later, or at the stated reset of a session limit hit inside it. Each
  Claude run's reported cost is added to the window it started in. When a
  session limit is hit, the window's spend (including the run that hit it)
  is kept as a capacity sample, at most once per window, last five kept;
  the window's *capacity* is the median of the samples. A stage's
  *estimate* is the median cost of its last ten `ok` runs on that model
  (stage name and model; seeded from `usage/` the first time the book is
  read). Given a strong-tier stage on Claude about to start, planning on
  (`quota.plan_windows`, default true), at least two capacity samples and
  an estimate, and the window's spend plus the estimate above the
  capacity, then the stage does not start: it waits until the window's end
  as in AC-6 and AC-7, and a `quota-defer` line is logged with stage,
  model, estimate, spend, capacity and window end. Otherwise it starts.
  Standard-tier stages are not deferred (they have the cheaper OpenAI
  fallback), so cheaper work keeps using the rest of the window.
  *(agent's call: median, two samples, strong tier only)*

**Model-specific limits**

- AC-9. Given a strong-tier Claude stage (chain stage, rescue or standing
  agent) whose model is blocked by a `model`-scope limit only,
  `quota.model_limit_fallback` true (default) and
  `quota.model_limit_fallback_model` (default `claude-opus-5-5`) not
  blocked and not the stage's own model, then the stage runs on that model
  instead of waiting, and a `quota-fallback` line is logged with stage,
  from-model, to-model and the limit key; the run's usage record names the
  model it ran on. Given the same limit hit by a run in progress with cost
  at or below `retry_cost_limit_usd`, then the stage is retried once on that
  model (as spec 001 AC-25's fallback retry). Given a session or weekly
  limit (key `claude`), then no Claude model is used and AC-5 to AC-7
  apply. Given the parameter false, then the stage waits as before. A
  standard-tier stage whose model is blocked runs on its own `fallback`
  when that is not blocked, without a 429 first.
  Default allowed: the maintainer chose on 2026-10-29 (relayed by the
  coordinating session) that strong-tier stages use the next-best
  available Claude model rather than idle for hours. Process-spec 6.5 and
  the predecessor's "never downgrade the judgment tier" were about moving
  judgment to a much cheaper model; Opus is the next Claude model below
  Fable, and the alternative observed live was 11 hours with no issue work.

**Visibility**

- AC-10. Given a tick while the book holds a limit with a future reset or
  something waits on quota, then the tick's service-log line carries
  `quota: { limits: [{key, scope, resets_at, source}], waiting: [{what,
  until, key}] }`; otherwise the field is absent. `scheduler quota` prints
  the whole book (limits, window, capacity samples, estimates and what
  waits) as JSON. A waiting entry is removed when its stage or agent next
  starts.

## 4. Interfaces and files

- `tools/scheduler/src/quota/parse.ts`: `parseLimit(reason, harness, model,
  now)` and the zone arithmetic (via `Intl.DateTimeFormat`, no new
  dependency).
- `tools/scheduler/src/quota/book.ts`: the book (`readBook`,
  `observeRun`, `blocking`, `planLaunch`, `markWaiting`, `quotaSummary`).
  `planLaunch` returns `{kind: "run", model, harness, note?}` or `{kind:
  "wait", until, key, reason}` and is the single launch decision for chain
  stages and standing agents.
- `tools/scheduler/src/state/paths.ts`: `quota` (`quota.json`).
- `tools/scheduler/src/runner/run.ts`: every run's usage and judgement go to
  `observeRun` when the run ends.
- `tools/scheduler/src/runner/retry.ts`: `retryDecision` takes the model
  fallback of AC-9.
- `tools/scheduler/src/chain/driver.ts`, `chain/machine.ts`,
  `chain/types.ts`: the launch decision before a stage's run; `stage_failed`
  with `postpone` carries `until`, which the `wait` action carries to
  `postponedUntil`.
- `tools/scheduler/src/standing/run.ts`, `standing/state.ts`
  (`postponed_until`), `service/loop.ts` (skip postponed agents, liveness
  exemption, tick summary).
- `tools/scheduler/bin/scheduler.ts`: `scheduler quota`.
- `agents/parameters.yaml`: `quota.model_limit_fallback` (boolean, true),
  `quota.model_limit_fallback_model` (string, `claude-opus-5-5`),
  `quota.plan_windows` (boolean, true), `quota.session_window` (duration,
  5h, 1h to 24h); all `auto`.
- `specs/001-scheduler-core/spec.md` AC-25: one sentence pointing here.
- Tests: `test/quota.test.ts` (AC-1 to AC-3, AC-8, AC-9 decisions),
  `test/driver.test.ts` (AC-4 to AC-6, AC-9 chain), `test/loop.test.ts`
  (AC-5 liveness), `test/e2e.test.ts` (AC-7 and AC-10 through the real
  runner; replaces the test that counted a rate-limited standing run as a
  failure), `test/retry.test.ts` (AC-9 retry).
- Not gated: a resumed session or a Telegram conversation turn keeps its
  session's model and meets a limit as a 429, as today.

## 5. Verification

- `pnpm test` from the repository root passes.
- The tests named in section 4 fail without the change.
- Live check after deploy, recorded in the PR or a dev-log: at the next
  session limit the service log shows one `quota-limit` line, the filer's
  `runs/` count does not grow until the stated reset, and the claim's
  `postponedUntil` equals the reset.

## 6. Open decisions

None.
