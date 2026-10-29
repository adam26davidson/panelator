# 016. Fair slot scheduling: answered questions first, standing agents and chains take turns

Status: written 2026-10-29 from the delivery-system design for issues #23
and #44; specs derived from that design need no maintainer approval (design
section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": on a reply the paused work
"returns to the shortlist ahead of everything else") and section 6.1
(standing agents run beside the issue chain); [design-tree](../../docs/design-tree.md)
R6.Q10 (pull on completion into a concurrency slot); amends
[008-agent-registry](../008-agent-registry/spec.md) AC-3 and its decision
"Standing agents take ordinary slots, after resumes and before the
shortlist", [009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md)
AC-4 and its section 4 resume rule; keeps
[006-no-human-stops](../006-no-human-stops/spec.md) AC-15 ("the resumed
issue takes the next free slot before any shortlisted issue") and makes it
hold against claims on disk too.

## 1. Goal

A tick hands out its running slots in this order today
(`tools/scheduler/src/service/loop.ts`, `Scheduler.tick`):

1. every claim on disk that may run (not paused, not postponed into the
   future) is started, until the running slots are full;
2. answered paused issues are resumed into what is left;
3. due standing agents take what is left;
4. the shortlist claims new issues into what is left.

Two defects follow when `slots` is small.

- **#23: standing agents starve.** With `slots: 1` and a queue of claims
  (issue #17 left four at once), step 1 fills the slot on every tick a
  claim can start, so a due standing agent waits until every claim has
  drained. Observed 2026-10-28: `agents/findings-filer.json` had pending
  `finding_queued` events and `last_run: null` while #13, #15 and #17 held
  claims. Spec 009 makes it stricter: free slots become `slots` minus the
  claims held on disk, so a postponed chain alone blocks standing agents for
  the whole of its wait.
- **#44: an answered question waits behind every claim.** Step 1 runs before
  step 2, so with claims on disk the answered issue is moved to `resuming`
  but not resumed until no claim can start. Under spec 009's held count it
  waits until fewer claims are held than `slots`. An answered question is
  the cheapest work to finish (its chain is mid-stage, the answer is fresh)
  and the design puts it "ahead of everything else".

The opposite of #23 must not happen either. Observed 2026-10-28/29: the
findings filer ran every one to two minutes for about 30 hours (1,284
`standing-findings-filer-*` run directories), each run failing on the rate
limit, because its own failure finding re-queued a `finding_queued` event.
Then the chains it ran beside were postponed, so no chain was kept out; but
nothing in the tick stops an agent that is always due from taking every
slot that frees while chains are ready.

After this spec a tick hands out running slots in this order: answered
paused issues first; then standing agents and issue chains take turns, one
grant each, so neither kind can hold every slot while the other has work
ready. The number of concurrent runs stays at most `slots`, the parameter
store's `slots` stays the only limit, and spec 009's rule that no new issue
is claimed while held claims fill `slots` is kept.

## 2. Out of scope

- The rate-limit retry of a standing agent and the self-wake through its own
  failure finding (#24); this spec only bounds the share of slots such an
  agent can take.
- A separate slot budget for standing agents, or any new parameter.
- How a chain is postponed or when a postponed chain becomes ready (spec
  001 AC-25, spec 006 AC-26, AC-27), liveness (spec 001 section 8), the
  pause itself, reminders and the Telegram flow (specs 006, 007).
- Ranking of the shortlist (spec 008 AC-11), and the order among standing
  agents (oldest `next_run` first, spec 008 AC-3), both kept.
- Persisting the turn across a restart.

## 3. Acceptance criteria

Terms. A *running slot* is free when the chains and standing agents running
in the process number fewer than `slots`. *Held* is spec 009's count: the
claims on disk whose issue has no paused record, plus any chain still
running in the process. A *ready chain* is a claim on disk that may start
(not running, not paused, not in stage `waiting` with `postponedUntil` in
the future, not handed a `chain_error` this tick), or, while held plus the
standing agents running is below `slots`, the next issue of the ranked
shortlist. A *due standing agent* is one spec 008 AC-3 would run: due,
not paused, not running. The *turn* is the kind of the last grant the
process made, `chain` or `standing`; it starts as `chain`, so after a
restart a due standing agent is granted first.

- AC-1. **An answered question resumes first.** Given `slots: 1`, a claim on
  disk that may start, and a paused issue P whose question the maintainer
  has answered, when a tick runs, then P is resumed into the running slot on
  that tick and the claim is not started; given P's chain later ends, then
  the claim is started on the next tick. The paused handling still needs
  the open-issue list; if listing fails, the error is recorded and the rest
  of the tick goes on without paused handling and without new claims.
- AC-2. **A held slot does not block an answered resume.** Given `slots: 1`,
  a claim in `waiting` with `postponedUntil` in the future, and an answered
  paused issue P, when a tick runs, then P is resumed on that tick (amends
  spec 009 AC-4). Given held is then 2 and the shortlist is non-empty, then
  no issue is claimed. Given the `waiting` claim's time passes while P's
  chain runs, then it starts only once P's chain has ended.
- AC-3. **An answered resume still needs a running slot.** Given `slots: 1`
  and a chain running in the process, when a tick runs with an answered
  paused issue, then P is not resumed and its record is kept; it is resumed
  on the first tick after the running chain ends, before any claim on disk,
  standing agent or shortlisted issue.
- AC-4. **Standing agents are not starved by claims.** Given `slots: 1`,
  three claims on disk that may start (held 3), the turn `chain`, and a due
  standing agent S, when a tick runs, then S runs and no claim is started.
  Given S's run ends and a tick runs, then the first claim in listing order
  is started and S, due again, does not run on that tick.
- AC-5. **A standing agent cannot monopolize the slot.** Given `slots: 1`, a
  due standing agent S that is due again as soon as each of its runs ends,
  and claims on disk that may start, when ticks run, then the first four
  grants are standing, chain, standing, chain: S never runs twice in a row
  while a chain is ready.
- AC-6. **Work-conserving.** Given `slots: 1` and the turn favouring one
  kind, when that kind has nothing ready and the other has, then the other
  takes the slot on that tick: a due standing agent runs while the only
  claim is `waiting` into the future; a claim starts while no standing agent
  is due. Given neither kind has anything ready, then nothing is granted.
- AC-7. **A postponed chain still holds its slot against new claims.**
  Given `slots: 1`, a claim in `waiting` into the future, a due standing
  agent and an eligible issue B, when a tick runs, then S runs, B is not
  claimed, and held is 1 (spec 009 AC-1 kept). Given `slots: 2`, held 0, a
  due standing agent and two eligible issues, then one standing agent runs
  and one issue is claimed, in rank order (held plus running standing agents
  never exceeds `slots` for a new claim).
- AC-8. **Bounded.** In every case above the chains and standing agents
  running in the process never exceed `slots`.

## 4. Interfaces and files

- `tools/scheduler/src/service/loop.ts`, `Scheduler.tick`: after liveness
  and the `chain_error` pass over the claims (which no longer stops at a
  full slot count), the tick (1) lists the open issues when a paused record
  exists and runs the paused handling with "slot free" meaning a free
  running slot, (2) computes held, (3) grants running slots one at a time,
  each to the kind the turn does not name, falling back to the other kind,
  until no running slot is free or neither kind has anything ready. Chains
  are tried as: claims on disk in listing order, then the ranked shortlist,
  computed at most once per tick and only when a new claim fits under held.
  The turn is a private field `#lastGrant` of the scheduler; a resume of an
  answered question does not change it. `TickInfo` gains `standing:
  string[]`, the agents started this tick, written to the service log with
  the rest. *(agent's call: the turn kept in memory, not on disk; one grant
  per kind per turn)*
- `tools/scheduler/test/loop.test.ts`: a `describe` for spec 016 with tests
  for AC-1 to AC-8, built on the file's `setup` helper; the spec 009 AC-4
  test and the spec 006 test "leaves a resume the record holds when no slot
  is free" (whose blocking claim now has to be running) updated to the new
  order.
- `specs/008-agent-registry/spec.md` and `specs/009-postponed-chain-holds-slot/spec.md`
  are not edited; this spec records the amended order.
- `docs/delivery-system-design.md`: this spec under `## Children`.

No other file is created or modified.

## 5. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean.
- The spec 016 loop tests fail before the change to `tick` (AC-1, AC-2,
  AC-4 and AC-5 grant in the old order) and pass after it.
- Live check after deploy, recorded in the PR: with a due standing agent
  and claims on disk, the service log's ticks show `standing` and `active`
  alternating between the agent and a chain; an answered question shows in
  `claimed` on the first tick with a free running slot after the answer.

## 6. Open decisions
