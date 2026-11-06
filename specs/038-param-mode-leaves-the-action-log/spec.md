# 038. The maintainer's mode change is recorded in the parameter history, not the action log

Status: written 2026-11-06 from the delivery-system design for issue #59;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design), section 6.2 (level 1 is the direct action; "every direct action
is recorded: what, why, which agent, and how to undo it"; locked parameters
cannot be changed by the system, enforced in code; the action audit reviews
the log kind by kind) and section 9 (parameters are auto or locked);
[charter](../../docs/charter.md) (each parameter is auto or locked; in locked
mode the maintainer's input cannot be changed by the system);
[008-agent-registry](../008-agent-registry/spec.md) AC-8 (action kinds are
defined in code and in `agents/actions.yaml`, and the two are cross-checked),
AC-9 (the action log's fields and its one writer), AC-11 (every parameter
change, value or mode, is appended to `parameters/history.jsonl` with its
actor), AC-12 (no action kind sets a mode; the only `maintainer` actor is the
command line), AC-17 (the maintainer's commands) and AC-23 (the audit's input
is the log grouped by kind plus the parameter history); amends spec 008 AC-17
as section 4 records.

## 1. Goal

Every row of the action log that records an effect names a kind that
`agents/actions.yaml` defines, so the action audit's per-kind grouping never
shows a kind with no definition. Today one row does not: the maintainer's
`param mode <name> auto|locked` command writes a row with kind
`parameter_mode`, which neither the file nor the kinds table in
`tools/scheduler/src/actions/index.ts` knows.

### What is wrong today

In `tools/scheduler/bin/scheduler.ts` the `param mode` branch calls
`actionLog.writePending({agent: 'maintainer', run_id: 'command', kind:
'parameter_mode', ...})` directly, then `parameters.setParameterMode(...)`,
then `actionLog.settle(...)`. Its sibling `param set` goes through
`applyAction` with the defined kind `set_parameter`. The registry test
(spec 008 AC-8) compares the `KINDS` constant with the file and finds them
equal, because `parameter_mode` is in neither; the row reaches the log only
because the command bypasses `applyAction`, the log's one intended writer
(spec 008 AC-9, section 4 "the action log one writer"). `buildAuditInput`
(`tools/scheduler/src/standing/audit-input.ts`) groups the log by `kind`, so
the audit's input shows a `parameter_mode` group whose kind it cannot look
up, and an audit finding "move action kind parameter_mode to level 2" would
name a kind that does not exist. The review stage of issue #10 noticed it
while checking spec 008 AC-12 (findings queue ref 29); the mode change
itself is correctly maintainer-only.

### The fix

The mode change is not a direct action, and nothing about it is lost when
it stops pretending to be one. Spec 008 AC-12 says in so many words that no
action kind sets a mode, and a test asserts it (`changesMode === false` for
every kind); design section 6.2 reserves the action log for level-1 direct
actions, the things the system may do and undo. The maintainer's mode change
is neither: it is the maintainer's alone, it has no undo (`undo: null` in
today's row), and it is already recorded where parameter changes are
recorded. `setParameterMode` appends a line to `parameters/history.jsonl`
with `field: 'mode'`, the old and new mode, `actor: 'maintainer'` and the
time (spec 008 AC-11), and the audit's input already carries that history
beside the grouped log (spec 008 AC-23). The action-log row is therefore a
duplicate under an undefined kind.

So the `param mode` command stops writing to the action log. It checks that
the parameter is defined (as `param set` does), calls `setParameterMode` as
`maintainer`, and prints the parameter's new state. Spec 008 AC-17's
sentence that both commands "are logged in the action log" is amended to say
where each is recorded. With that, `applyAction` is the only code that writes
the log, and a test pins it.

The issue offers two other fixes; neither is right.

- *Define `parameter_mode` in `agents/actions.yaml` as a maintainer-only
  kind.* A kind in the file must have code in the kinds table (spec 008
  AC-8), and a kinds-table entry that calls `setParameterMode` is an action
  kind that sets a mode, which spec 008 AC-12 forbids and its test rejects.
  It would also need a third level beyond `1` and `2` (the loader rejects
  any other), and it would put the mode change within reach of
  `applyAction`, so that an agent definition could list it and only the
  actor check would stand between the system and a lock. The charter's
  promise that a locked parameter cannot be changed by the system is best
  kept by the current shape: no kind, no path.
- *Log the mode change under an existing kind with the mode in `args`.* A
  `set_parameter` row with `{ name, mode }` is a row the kind's own check
  would refuse (`exact(args, ['name', 'value'])`), it would make the audit
  count mode changes as value changes, and an undo of it would be undefined.

Two precisions the issue's last sentence needs. First, "the audit should
never meet an undefined kind" holds for rows that record an effect. A
refused request is logged with the kind it asked for (spec 008 AC-8 and
AC-9: "the refusal is logged with the reason"), so an agent that asks for a
kind that does not exist leaves a `refused` row with reason `unknown action
kind`, and the audit may meet that kind in its grouping; that is the
evidence it needs to see. The invariant this spec establishes is: every row
whose status is `applied`, `failed` or `undone` names a kind in
`agents/actions.yaml`. Second, the invariant is kept by the log having one
writer, `applyAction`, which refuses an unknown kind before anything is
applied, not by a check inside the log (the log module cannot import the
kinds table without a cycle, and a check there would duplicate
`applyAction`'s).

No ADR: the question is small (one command, one amended sentence), the
decision follows from spec 008 AC-12 and design section 6.2 as written, and
it reverses nothing recorded. The reasoning stays here.

## 2. Out of scope

- `setParameterMode`, `setParameter`, the parameter store and its history
  file (`tools/scheduler/src/parameters/store.ts`): unchanged. The history
  line the command relies on is already written.
- `agents/actions.yaml`, the kinds table, `applyAction`, the levels, the
  undo mechanics and the registry cross-check (spec 008 AC-8 to AC-10):
  unchanged. No kind is added or removed.
- The action audit's definition and input builder
  (`agents/standing/action-audit.md`,
  `tools/scheduler/src/standing/audit-input.ts`): unchanged. It already
  receives the parameter history; after this spec that is where the mode
  change appears, as it always has.
- `param set`, `param list`, `agent pause|resume|run`, `action list|undo`
  and `quota`: unchanged.
- A command that prints the parameter history: not added. `param list`
  shows each parameter's current mode, `set_by` and time; the history file is
  in the state directory; the console (spec 030) is where a history view
  belongs.
- Any row in the action log already written with kind `parameter_mode`: left
  as it is. The log is append-only (spec 008 AC-9) and nothing rewrites
  earlier lines. The audit may meet that kind once in its 30-day context
  window after deploy; the entries show `agent: maintainer`, `status:
  applied` and a `why` naming the command, so there is nothing to move to
  level 2, and the group disappears from the window within 30 days.
- Spec 030's `contact_refused` row (spec 030 AC-11), which is also written to
  the action log under a kind the file does not define, and spec 030 AC-12's
  `contacts remove` logging. Spec 030 is not implemented yet; it is recorded
  in this spec's result as a finding rather than changed here.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory, `agents/parameters.yaml`'s
definitions and `agents/actions.yaml`'s levels, as in
`tools/scheduler/test/actions.test.ts` and `parameters.test.ts`. "The
command" is the body of the `param mode` branch of
`tools/scheduler/bin/scheduler.ts`, which section 5 moves into a function the
tests call directly.

- AC-1. **A mode change is recorded in the history only.** Given
  `system_work_share` is `auto`, when the command runs with name
  `system_work_share` and mode `locked`, then `parameters.json` shows the
  parameter with `mode: 'locked'` and `set_by: 'maintainer'`, exactly one
  line is appended to `parameters/history.jsonl` and it has `name:
  'system_work_share'`, `field: 'mode'`, `old: 'auto'`, `new: 'locked'` and
  `actor: 'maintainer'`, and `actions/log.jsonl` is unchanged (it does not
  exist, or has exactly the lines it had before). Running the command again
  with mode `auto` restores the mode and appends one more history line; the
  action log is still unchanged.
- AC-2. **The command confirms what it did.** Given AC-1's first run, then
  the command prints one line of JSON holding the parameter's new state:
  `{ name, value, mode, set_by, at }` as `param list` would show it for that
  name, with `mode: 'locked'` and `set_by: 'maintainer'`, and exits 0.
- AC-3. **A refused change records nothing.** Given a name that
  `agents/parameters.yaml` does not define, or a mode that is neither
  `auto` nor `locked`, when the command runs, then it exits non-zero with
  the reason (`undefined parameter <name>`, or the store's `mode must be
  auto or locked`), `parameters.json` and `parameters/history.jsonl` are
  unchanged, and `actions/log.jsonl` is unchanged.
- AC-4. **`applyAction` is the action log's only writer.** Given the source
  under `tools/scheduler/src/` and `tools/scheduler/bin/`, then the only
  call of `writePending(` outside `tools/scheduler/src/actions/log.ts` is
  the one in `tools/scheduler/src/actions/index.ts`; a test under
  `tools/scheduler/test/` reads the two directories and asserts it (in the
  style of spec 022 AC-11's "no code under `src/aws/` calls
  `setParameter`"). Tests themselves may call `writePending` (one already
  does, to exercise `markStalePending`).
- AC-5. **Effects carry defined kinds; refusals carry what was asked.**
  Given a log written only through `applyAction` holding one applied
  `set_parameter`, one `undo` of it, and one request for kind
  `parameter_mode` from an agent whose `actions` list is `['set_parameter']`,
  when `buildAuditInput` runs over it, then every key of its `kinds` whose
  group has `applied`, `failed` or `undone` above zero is a key of
  `agents/actions.yaml`, and the `parameter_mode` group has `refused: 1`,
  `applied: 0` and its entry's `reason` is `unknown action kind`. Nothing in
  `buildAuditInput` changes; the test pins the invariant section 1 states.
- AC-6. **The landed text follows.** Given the implementation PR's diff,
  then spec 008 AC-17 reads as section 4 gives it, no other line of spec 008
  changes, and no text marked `(maintainer answer, question #<id>)` changes
  anywhere.

## 4. Amendments to earlier specs

- **Spec 008 AC-17**, the second sentence. Today: "`param set <name>
  <value>` and `param mode <name> auto|locked` call the functions of AC-12
  as `maintainer` and are logged in the action log with `agent:
  maintainer`." It becomes: "`param set <name> <value>` calls `setParameter`
  of AC-12 as `maintainer` through the `set_parameter` kind and is logged in
  the action log with `agent: maintainer`; `param mode <name> auto|locked`
  calls `setParameterMode` as `maintainer`, prints the parameter's new
  state, and is recorded in the parameter history of AC-11 with `actor:
  maintainer`, not in the action log, since no action kind sets a mode
  (AC-12; spec 038)." Nothing else in spec 008 changes: AC-9's "`maintainer`
  for the commands of AC-6, AC-10 and AC-17" stays true of the commands that
  still write the log, and AC-12 and AC-23 already describe what this spec
  relies on.

## 5. Interfaces and files

- `tools/scheduler/bin/scheduler.ts`, the `param mode` branch: becomes a
  call of a function (below) and a `console.log(JSON.stringify(state))` of
  what it returns, inside the existing `try`, so a thrown error exits 1 with
  its message as the sibling branches do. The `withStateLock(actionLog.path
  + '.operation', ...)` wrapper goes with the log row: `setParameterMode`
  takes the parameter store's own lock, and nothing else in the branch
  touches shared state.
- A function the tests can call without spawning the binary, for example
  `setParameterModeCommand(parameters: ParameterStore, name: string, mode:
  string): Promise<{ name: string } & ParameterValue>` in
  `tools/scheduler/src/parameters/store.ts` (beside the store) or in a new
  `tools/scheduler/src/parameters/command.ts`; the builder picks the place.
  It throws `undefined parameter <name>` when `parameters.definitions` has no
  such name (the same check and message as `param set`), calls
  `parameters.setParameterMode(name, mode as 'auto' | 'locked',
  'maintainer')` (the store rejects any other mode string), and returns
  `{ name, ...await parameters.read(name) }`. It does not take the action
  log.
- `tools/scheduler/test/parameters.test.ts` (or `actions.test.ts`): tests
  for AC-1 to AC-3 against a temporary state directory, asserting the
  history line, the unchanged action log and the returned state.
- `tools/scheduler/test/actions.test.ts`: the source assertion of AC-4 (read
  `tools/scheduler/src/**/*.ts` and `tools/scheduler/bin/*.ts`, filter
  lines containing `writePending(`, assert the set of files is exactly
  `src/actions/log.ts` and `src/actions/index.ts`) and the audit-input test
  of AC-5 (build a log through `applyAction`, run `buildAuditInput`, check
  the groups against `loadActionLevels('agents/actions.yaml')`).
- `specs/008-agent-registry/spec.md` AC-17: the amendment of section 4
  (AC-6).
- `tools/README.md`: if it documents `param mode`, its line gains "prints
  the parameter's new state; recorded in the parameter history". Nothing
  else in it changes.

The spec PR itself adds
`specs/038-param-mode-leaves-the-action-log/spec.md` and lists this spec
under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The change
touches no gate, bound, label rule or permission. The property worth the
reviewer's glance is strengthened, not weakened: the mode change still runs
only as the `maintainer` actor from the command line, `setParameterMode`
still refuses every other actor (spec 008 AC-12, unchanged and still
tested), and after this spec no code path writes the action log except
`applyAction`, which refuses an unknown kind before applying anything.

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test fails on `main` (the branch body, called with a log, appends
  a `parameter_mode` row) and passes after the change; the AC-4 test fails on
  `main` (`bin/scheduler.ts` calls `writePending(`) and passes after.
- `grep -rn "parameter_mode" tools/scheduler/src tools/scheduler/bin agents`
  finds nothing; `grep -rln "writePending(" tools/scheduler/src tools/scheduler/bin`
  lists exactly `tools/scheduler/src/actions/log.ts` and
  `tools/scheduler/src/actions/index.ts`.
- `git diff main -- specs/008-agent-registry/spec.md` shows only the one
  amended sentence of section 4 (AC-6).
- Live check after deploy: `panelator-scheduler param mode system_work_share
  locked` prints the parameter's state with `mode: "locked"`; `param list`
  agrees; `action list --since <a minute ago>` shows no new row; the last
  line of `parameters/history.jsonl` in the state directory has `field:
  "mode"` and `actor: "maintainer"`. Then `param mode system_work_share
  auto` to restore it.

## 7. Open decisions

None.
