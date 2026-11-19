# 086. Six scheduler records are checked against their schemas

Status: written 2026-11-19 from the delivery-system design for issue #173;
specs derived from that design need no maintainer approval (design section 11).
No earlier spec's text is marked: this spec adds checks that spec 008 does not
rule out and changes no behaviour an earlier criterion describes.
Class: debt. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 ("Registry": standing agents, their state and their input and
output schemas), section 6.2 (actions, the action log and the parameters
they change) and section 10 ("Small work skips layers": a debt spec hangs
directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-8 to AC-11 (actions,
the action log, the parameter definitions and store) and section 5 (which
added the six schema files);
[041-registry-validates-standing-definitions](../041-registry-validates-standing-definitions/spec.md)
(the pattern this spec follows, and section 2's out-of-scope entry that
recorded this debt);
consistent with [014-filer-batch-integrity](../014-filer-batch-integrity/spec.md)
(the triage log the filer's batch writes and its cursor follows), [026-event-store](../026-event-store/spec.md) (the event
payloads that reference these schemas) and
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
(the `outage` field of an agent's state).

## 1. Goal

Each of the six scheduler records that issue #173 names is checked against
its schema under `schemas/scheduler/` by the code that loads or writes it,
and each schema says what the code's types say, so a field added to the
code without its schema (or the reverse) fails a test instead of drifting
unnoticed. This is what spec 041 did for `standing-definition.json`.

### What is true today

The issue lists `parameter-definition`, `parameters`, `agent-state`,
`action`, `action-log-entry` and `triage-entry` as compiled and never used.
Reading the code and the schemas while writing this spec gives three
different situations:

- **Not used at all.** `parameter-definition.json`, `parameters.json` and
  `agent-state.json` are referenced by no code and no other schema.
  `loadParameterDefinitions` (`tools/scheduler/src/parameters/definitions.ts`)
  checks `agents/parameters.yaml` by hand (key list, name pattern, type and
  mode values, non-empty description, `default` present, number limits are
  numbers). `ParameterStore` (`src/parameters/store.ts`) writes
  `parameters.json` in the state directory unchecked, and
  `writeAgentState` (`src/standing/state.ts`) writes `agents/<name>.json`
  unchecked. `parameter-definition.json` also cannot be used as checked in:
  its `min` and `max` are `{"type": ["number", "string"]}`, which the
  validator's `Ajv2020({ allErrors: true, strict: true })` refuses to
  compile ("strict mode: use allowUnionTypes to allow union type keyword",
  checked while writing this spec). `validate.ts` only adds the schemas at
  start-up and compiles one on its first `validate`, so the error has
  never surfaced. `agent-state.json` allows any extra key
  (`additionalProperties: true`) and leaves `last_run`, `pending_events`'
  items and the keys `summary`, `removed_at`, `running` and
  `postponed_until` undescribed.
- **Used through a reference, at the right moment.** `action.json` is the
  item schema of `standing-result.json`'s `actions` (`"$ref":
  "action.json"`), and `filer-result.json` extends `standing-result.json`.
  The runner validates every standing run's output against its definition's
  `output` schema (`src/runner/run.ts` line 212), so every action a
  standing agent proposes is already checked against `action.json` before
  it reaches the action layer. The issue's search for `validate('action'`
  did not find this because the call names the result schema. Nothing is
  missing here except a test that pins the use.
- **Used through a reference, too late.** `event.json` checks the payload
  of an `action` event against `action-log-entry.json` and of a
  `finding.triaged` event against `triage-entry.json`, and `recordEvent`
  (`src/events/store.ts`) throws on a failure. But `ActionLog`
  (`src/actions/log.ts`) appends the row to `actions/log.jsonl` before it
  records the event, and the filer (`src/filer/apply.ts` lines 202 to 203)
  appends its rows to `findings/triage.jsonl` before it records theirs, so
  a malformed row is already in the log when the check fails. And
  `triage-entry.json` allows any extra key and describes only eight of the
  nineteen fields of `TriageEntry` (`src/filer/input.ts` line 15), so a
  field added to the filer never reaches the schema.

### The fix

For each record, the code that loads or writes it calls `validate` with
its schema name before it uses or writes the record, and throws on a
failure, as `writeClaim` and `writePaused` already do. Writes are checked;
reads of state files are not, as for claims and paused records, so a state
file written by an earlier version never stops the service. The schemas are
tightened to say what the code's types and removed hand checks say: closed
key sets (`additionalProperties: false`), the shapes of nested objects, and
`date-time` formats on the timestamps the code writes with
`toISOString()`.

Every tightened schema was checked while writing this spec: it compiles
under the validator's options alongside the other schemas (including
`event.json`, which references two of them), it accepts all nine
definitions of `agents/parameters.yaml`, and it accepts the live state of
the maintainer's running scheduler (four agent state files,
`parameters.json`, the 30 rows of `actions/log.jsonl` and the 1083 rows of
`findings/triage.jsonl`). Turning on write-time checks therefore rejects
nothing the scheduler writes today.

No schema is deleted: every one of the six describes a record the code
reads or writes. No ADR: this is tooling debt with one clearly right
answer, and the mechanism is the one the scheduler already uses for its
other records.

## 2. Out of scope

- Validating state files on read (`readAgentState`, `ParameterStore.stored`,
  `ActionLog.list`, the filer's `readJsonLines` of the triage log): not
  done, as for claims and paused records. A row written before this spec
  stays readable.
- The runtime refusals in `applyUnlocked` (`src/actions/index.ts`): `why
  must have at least 20 characters` and `args must be an object` stay. They
  serve maintainer commands, which do not pass through a standing result,
  and they produce a logged refusal (spec 008 AC-9), which a schema failure
  would not. `action-log-entry.json` keeps `why` as any string so a refused
  row with a short `why` can be logged.
- `agents/actions.yaml` (the action catalogue read by `loadActionLevels`):
  `action.json` describes a proposed action, not a catalogue entry, and no
  schema describes the catalogue. The issue names the file as a test
  fixture under the assumption that `action.json` describes it; it does
  not, and adding a catalogue schema is new work, not this debt.
- `parameters/history.jsonl` and the `parameter.changed` event: unchanged.
- `checkParameter` (value type and range): unchanged. It checks values set
  at run time as well as each definition's `default`, and a range relative
  to `min` and `max` is not a JSON Schema check.
- `tools/scheduler/src/schema/validate.ts` and its error format: unchanged.
  The six names stay in `NAMES` because all six are now used.
- `event.json`: the file is unchanged. Its `action` and `finding.triaged`
  payload checks become as strict as the tightened schemas they reference,
  which is intended. The one-time backfill (spec 026 AC-4) only counts an
  old row that fails as `old_shape` and still records it.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"The validator's message" for an error is the string `validate` builds for
it in `tools/scheduler/src/schema/validate.ts`: the instance path (`/` at
the root), the Ajv message and the error's params as JSON. "Its messages"
for a failed `validate` are those strings joined by `; `. Every message
quoted below was produced by the section 5 schemas under the validator's
options while writing this spec.

**Parameter definitions**

- AC-1. **The loader checks each definition against the schema first.**
  Given a temporary `parameters.yaml` holding one definition `base` (`name:
  x`, `type: number`, `default: 1`, `mode: auto`, `description: d`) changed
  as below, when `loadParameterDefinitions(file, {slots: 1}, {})` runs, then
  it throws `<file>: parameter 0: ` followed by the validator's messages:
  with `unknown: true`, `/ must NOT have additional properties
  {"additionalProperty":"unknown"}`; with `name: Bad Name`, `/name must
  match pattern "^[a-z][a-z0-9_.-]*$" ...`; with `type: text`, `/type must
  be equal to one of the allowed values ...`; with `mode: frozen`, `/mode
  must be equal to one of the allowed values ...`; with `description: ''`,
  `/description must NOT have fewer than 1 characters {"limit":1}`; with
  `default` removed, `/ must have required property 'default'
  {"missingProperty":"default"}`; with `min: '1'`, a message starting
  `/min must be number {"type":"number"}`; with `type: duration`,
  `default: 1h`, `max: soon`, a message starting `/max must match pattern`.
  The index is the definition's zero-based position in the list (`parameter
  1: ` for the second). On `main` these cases fail with the hand checks'
  messages (`x: unknown key unknown`, `missing or invalid parameter key`,
  `x: min/max must be numbers`), so a test on any one of them distinguishes
  the two.
- AC-2. **The loader keeps what the schema cannot say.** Given a file that
  is not a list, then it throws `<file>: expected list`; given `base`
  twice, then `<file>: duplicate name x`; given `base` with `default: 3`
  and `max: 2`, then `<file>: x: out of range` (from `checkParameter`);
  given a standing agent with a schedule and a definition named
  `schedule.<agent>`, then `<file>: duplicate name schedule.<agent>`. The
  `slots` default is still replaced by `cfg.slots`, and one
  `schedule.<agent>` parameter is still created per scheduled standing
  agent, as on `main`. These checks run after the schema check of the same
  definition.
- AC-3. **The repository's definitions pass and load as before.** Given
  `agents/parameters.yaml` as checked in, when each item is passed to
  `validate('parameter-definition', item)`, then each is `{ ok: true }` (a
  direct test in `schema.test.ts`); and when the file is loaded, then the
  result has the same names, types, defaults, limits, modes and
  descriptions as on `main` (the existing tests that load it keep passing).

**Parameter store**

- AC-4. **The store checks what it writes.** Given a `ParameterStore`
  whose stored object, after a change, would fail `parameters.json` (for
  example a `set_by` of `''`), when it would write `parameters.json`
  (`setParameter`, `setParameterMode`, `initialize` or `prune`), then it
  throws `invalid parameters: ` followed by the validator's messages (for
  the example, `/<name>/set_by must NOT have fewer than 1 characters
  {"limit":1}`), and `parameters.json` and `parameters/history.jsonl` are
  unchanged. Given the existing parameter tests, then they pass: every
  write they make is valid.

**Agent state**

- AC-5. **Agent state is checked before it is written.** Given a state
  directory with an agent `test`, when `writeAgentState(paths, 'test',
  state)` or `updateAgentState` writes a state that fails
  `agent-state.json`, then it throws `invalid agent state test: ` followed
  by the validator's messages, and `agents/test.json` is unchanged. The
  cases a test asserts: an extra key `bogus: 1` (`/ must NOT have
  additional properties {"additionalProperty":"bogus"}`), `running` without
  `started_at` (`/running must have required property 'started_at'
  {"missingProperty":"started_at"}`) and `failures: -1` (`/failures must be
  >= 0 {"comparison":">=","limit":0}`).
- AC-6. **Every state the scheduler writes passes.** Given the existing
  standing, loop and action tests, which write fresh states, pending
  events, runs, results, pauses, postponements, outages and removals, then
  they pass with the check in place; and a direct test in `schema.test.ts`
  asserts that a state with every optional key present (`summary`,
  `removed_at`, `running`, `postponed_until`, `outage` with `past_ceiling`
  and `ceiling`) and a non-null `last_run` and a pending event is `{ ok:
  true }`.

**Proposed actions**

- AC-7. **A proposed action is checked through the standing result.**
  Given a standing result `{summary: 's', actions: [{kind: 'run_agent',
  args: {name: 'x'}, why: <a string of 20 characters or more>}]}`, when
  `validate('standing-result', r)` is called, then it is `{ ok: true }`;
  with `why: 'short'`, then its messages are `/actions/0/why must NOT have
  fewer than 20 characters {"limit":20}`; with `args: []`, then
  `/actions/0/args must be object {"type":"object"}`. (A test in
  `schema.test.ts`; no source changes for `action.json`.)

**Action log**

- AC-8. **A log row is checked before it is written.** Given an
  `ActionLog` on a temporary state directory, when `writePending` is given
  an entry whose row fails `action-log-entry.json` (an `undo` of `{kind:
  'k'}` without `args`), then it throws `invalid action log entry: `
  followed by the validator's messages (starting `/undo must be null`), and
  `actions/log.jsonl` is unchanged and no `action` event is recorded. When
  `settle` is given a row that would fail (an `undo` without `args`), then
  it throws the same way and `actions/log.jsonl` is unchanged. Given the
  existing action tests (applied, refused, failed and undone rows), then
  they pass.

**Triage log**

- AC-9. **Triage rows are checked before they are appended.** Given the
  filer applying a batch, when it appends a decision's row and its copies
  to `findings/triage.jsonl`, then each is first passed to
  `validate('triage-entry', row)`; on a failure the filer throws `invalid
  triage entry <ref>: ` followed by the validator's messages, nothing of
  that decision is appended and no `finding.triaged` event is recorded for
  it. Given the existing filer tests, which write every kind of row
  (filed, merged, discarded and resting, deferred, retried, security and
  held, blocked), then they pass with the check in place.
- AC-10. **The triage schema describes every field.** Given
  `validate('triage-entry', row)` (a test in `schema.test.ts`), then a row
  with only the five required fields passes; a row with every optional
  field of section 5 passes; and a row with `foo: 1` fails with `/ must NOT
  have additional properties {"additionalProperty":"foo"}`, with `failure:
  'other'` fails with `/failure must be equal to one of the allowed values
  ...`, and with `blocked_by: [0]` fails with `/blocked_by/0 must be >= 1
  {"comparison":">=","limit":1}`.

**All six**

- AC-11. **Each schema compiles and is used.** Given the implementation's
  source, then `validate` is called with `'parameter-definition'`
  (`definitions.ts`), `'parameters'` (`store.ts`), `'agent-state'`
  (`state.ts`), `'action-log-entry'` (`log.ts`) and `'triage-entry'`
  (`apply.ts`), and `action.json` is reached through `standing-result`
  (AC-7); and the tests of AC-1 to AC-10 compile each of the six schemas
  under the validator's options (so a schema that does not compile, as
  `parameter-definition.json` does not on `main`, fails `pnpm test`).
- AC-12. **No hand check duplicates the schema.** Given the implementation
  PR's diff of `src/parameters/definitions.ts`, then
  `loadParameterDefinitions` contains no list of allowed keys, no check of
  `name`'s pattern, of `type`'s or `mode`'s values, of `description` or of
  `default`'s presence, and no check that a number's `min` and `max` are
  numbers; the checks AC-2 names are the ones that remain.

## 4. Amendments to earlier specs

None. Spec 008 AC-11 names the fields of a parameter definition and of the
store, which the tightened schemas describe without change; spec 041
section 2's out-of-scope entry remains true of spec 041 and is carried out
here.

## 5. Interfaces and files

- `schemas/scheduler/parameter-definition.json`: same `$schema`, `$id`,
  `type`, `required` and `additionalProperties: false`, with:
  - `name`: `{"type": "string", "pattern": "^[a-z][a-z0-9_.-]*$"}` (the
    loader's regex; replaces `minLength: 1`).
  - `min` and `max`: `{"anyOf": [{"type": "number"}, {"type": "string"}]}`
    (replaces the union type the strict validator refuses).
  - a top-level `allOf` of two `if`/`then` pairs (each `if` and `then`
    carries `"type": "object"`, as strict mode requires): when `type` is
    `number`, `min` and `max` are `{"type": "number"}`; when `type` is
    `duration`, they are `{"type": "string", "pattern":
    "^\\d+(\\.\\d+)?[mhd]$"}` (`parseDuration`'s syntax, as in
    `standing-definition.json`).
  - `type`, `default`, `mode`, `description` as today.
- `schemas/scheduler/parameters.json`: as today, with `set_by`
  `{"type": "string", "minLength": 1}`.
- `schemas/scheduler/agent-state.json`: the same six required keys, and
  `additionalProperties: false`. Below, `T` is `{"type": "string",
  "format": "date-time"}` and every nested object has `"type": "object"`
  and `additionalProperties: false`:
  - `last_run`: `{"type": ["object", "null"]}` with `at` (`T`), `run_id`
    and `outcome` (strings, `minLength: 1`), all three required;
  - `next_run`: `{"type": ["string", "null"], "format": "date-time"}`;
  - `pending_events`: an array of objects with `event` (string, `minLength:
    1`), `payload` (`{}`) and `at` (`T`); `event` and `at` required
    (`payload` is not, so an event emitted without one stays valid);
  - `paused`, `paused_by`, `failures`: as today;
  - `summary`: string; `removed_at`, `postponed_until`: `T`;
  - `running`: `run_id` (string, `minLength: 1`) and `started_at` (`T`),
    both required;
  - `outage`: as today, closed, with `past_ceiling` closed.
- `schemas/scheduler/action.json`: unchanged.
- `schemas/scheduler/action-log-entry.json`: as today, with `undo`
  `{"oneOf": [{"type": "null"}, <inverse>]}` where `<inverse>` is a closed
  object with `kind` (string, `minLength: 1`) and `args` (object), both
  required; and `undoes` with `minLength: 1`.
- `schemas/scheduler/triage-entry.json`: `additionalProperties: false`, the
  same five required keys, `ref` and `outcome` with `minLength: 1`
  (`outcome` stays a string, not the filer-result enumeration, because the
  filer also writes outcomes of its own, such as `defer` after the retry
  limit), and these optional properties besides `rests_on_pr`,
  `rests_on_pr_state` and `reoffered` (as today): `issue`, `attempt`,
  `capability_issue` (`{"type": "integer", "minimum": 1}`); `advisory`,
  `blocked_until` (strings, `blocked_until` with `minLength: 1`); `failed`,
  `held`, `stops_pipeline` (booleans); `failure` (`{"enum": ["permission",
  "error"]}`); `blocked_by` (an array of integers of at least 1,
  `minItems: 1`); `finding` (`{"type": "object"}`, not a reference to
  `finding.json`: a triage row copies the queued record's finding, and a
  record queued under an older `finding.json` must not stop the filer).
  These are the fields of `TriageEntry` in `src/filer/input.ts`.
- `tools/scheduler/src/parameters/definitions.ts`,
  `loadParameterDefinitions`: for each item `d` at index `i`, first
  `validate('parameter-definition', d)`, throwing
  `new Error(\`parameter ${i}: ${v.errors.join('; ')}\`)` on failure (the
  existing `catch` prefixes the path); then the duplicate check, the two
  `checkParameter` calls and the `slots` replacement, unchanged. Remove the
  hand checks AC-12 names. `checkParameter` and `ParameterDefinition` are
  unchanged.
- `tools/scheduler/src/parameters/store.ts`: one private method writes
  `parameters.json` (temporary file and rename, as today) after
  `validate('parameters', all)`, throwing `invalid parameters: ...`;
  `change`, `initialize` and `prune` use it. In `change` the check runs
  before the history line and the event, so a rejected change leaves no
  trace.
- `tools/scheduler/src/standing/state.ts`, `writeUnlocked`:
  `validate('agent-state', state)` before writing, throwing
  `invalid agent state <name>: ...`. `AgentState` is unchanged.
- `tools/scheduler/src/actions/log.ts`: a check of the row with
  `validate('action-log-entry', row)` in `writePending` before the append,
  and in `settle` on the changed row before the rewrite, throwing `invalid
  action log entry: ...`. `LogEntry` is unchanged.
- `tools/scheduler/src/filer/apply.ts`: before the `appendFile` of
  `[row, ...copies]` (line 202), each is checked with
  `validate('triage-entry', c)`, throwing `invalid triage entry <ref>: ...`.
- `tools/scheduler/test/parameters.test.ts`: the rejection loop (line 28)
  asserts the messages of AC-1 and AC-2 and gains their cases; a test of
  AC-4.
- `tools/scheduler/test/standing.test.ts`: a test of AC-5.
- `tools/scheduler/test/actions.test.ts`: a test of AC-8.
- `tools/scheduler/test/schema.test.ts`: tests of AC-3 (each item of
  `agents/parameters.yaml`), AC-6, AC-7 and AC-10, plus representative
  passing records for `parameters` and `action-log-entry`.

## 6. Verification

`pnpm test` from the repository root passes, including the new tests of
section 5. The tests of AC-1, AC-5 and AC-8 fail on `main` (the messages
differ, or nothing is thrown), and the `schema.test.ts` test of AC-3 fails
on `main` because `parameter-definition.json` does not compile there.

## 7. Open decisions

None.
