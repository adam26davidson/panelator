# 041. The registry validates standing definitions against their schema

Status: written 2026-11-06 from the delivery-system design for issue #70;
specs derived from that design need no maintainer approval (design section 11).
Class: debt. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 ("Registry": a standing agent is a file with its trigger,
harness, model, bounds, input and output schemas, mirroring stage
definitions) and section 10 ("Small work skips layers": a debt spec hangs
directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-1 (the fields of a
standing definition and what loading rejects), amended by this spec as
section 4 records, and section 5 (`schemas/scheduler/standing-definition.json`
is one of the files that spec added); consistent with
[028-reflection-agents](../028-reflection-agents/spec.md) AC-4 and
[030-beyond-github](../030-beyond-github/spec.md) section 5, whose
implementations add `trigger.min_events` and `credentials` to the same
schema.

## 1. Goal

A standing agent definition under `agents/standing/` is checked against
`schemas/scheduler/standing-definition.json` when it is loaded, and the
schema is the one record of the definition's shape. Today the schema is
registered with the validator and never used: the loader checks the
frontmatter by hand (key list, required keys, trigger shape, enumerations),
so the schema and the loader describe the same file twice and nothing
notices when they disagree.

### What is wrong today

`parseStandingDefinition` in `tools/scheduler/src/standing/registry.ts`
parses the YAML frontmatter and then runs some twenty hand-written checks:
the list of known keys, the required string keys, the `name` pattern,
`kind: standing`, the `worktree` values, the shape of `trigger` (an object
whose keys are `schedule` or `events`, not empty), the type of `schedule`
and `events`, the `actions` array, the `effort` type and the patterns of
`profile`, `input` and `output`. `schemas/scheduler/standing-definition.json`
says most of the same things in JSON Schema. The validator in
`tools/scheduler/src/schema/validate.ts` compiles that schema at start-up
under the name `standing-definition`, and no code calls
`validate('standing-definition', ...)`: the loader imports `schemaDir` from
the same module only to check that the `input` and `output` schema files
exist. The schema is therefore dead for validation. Spec 028 AC-4 asks for
`trigger.min_events` in both places, and the implement stage of issue #15
had to add it to the schema and to the hand check separately, which is how
the duplication was noticed (filer verification of issue #70 on commit
601b87d).

### The fix

The loader validates the parsed frontmatter against
`standing-definition.json` before anything else, and the hand checks that
the schema can express are removed, so the schema is the single description
of a definition's shape. The schema is tightened to carry what the removed
checks said: the `name`, `profile`, `input` and `output` patterns, the
`trigger` keys and the duration syntax of `schedule`, a non-empty `events`
list, and the three positive `bounds`. The loader keeps only the checks a
JSON Schema cannot make or that the loader shares with stage definitions:
the schedule's range (an interval between `1h` and `30d`), the event names
(a runtime list), the action kinds (read from `agents/actions.yaml`), the
reserved profile name `from-issue`, the `output` schema extending
`standing-result` and the `input` schema file existing (both read from
disk), the fallback rule shared with stage definitions
(`sharedDefinitionChecks`), and, in `loadRegistry`, that `name` equals the
file name.

A failure still names the file and the key (spec 008 AC-1): `loadRegistry`
prefixes the file path as it does today, and the validator's errors carry
the instance path and the offending property. The service still exits 78 on
a bad definition, and the vitest registry test over the repository's
`agents/standing/` still runs the same loader, so both repository agents
are now checked against the schema on every `pnpm test`. A later spec that
adds a key (spec 028's `min_events`, spec 030's `credentials`) adds it to
the schema, as those specs already say, and that is where it takes effect.

No ADR: the issue is tooling debt with one clearly right answer, and the
mechanism (compile every schema under `schemas/scheduler/` at start-up and
call `validate`) is the one every other input and result of the scheduler
already uses.

## 2. Out of scope

- Stage definitions (`agents/stages/*.md`, `parseStageDefinition`): no
  schema describes them today and this spec adds none. `sharedDefinitionChecks`
  keeps serving both kinds of definition unchanged.
- `trigger.min_events` (spec 028 AC-4) and `credentials` (spec 030): added
  to the schema and the loader by those specs' implementations, not here.
  The tightened `trigger` object (section 5) rejects `min_events` until
  spec 028 adds it, which is what the loader does today.
- What a definition means once loaded: triggers, schedules as parameters,
  pending events, slots, placeholders, pausing (spec 008 AC-2 to AC-4 and
  AC-13): unchanged. The `StandingDefinition` type in
  `tools/scheduler/src/types.ts` is unchanged.
- The other schemas under `schemas/scheduler/` with no `validate` caller
  (`parameter-definition.json`, `agent-state.json`, `action.json`,
  `action-log-entry.json`, `triage-entry.json`): the same kind of debt,
  recorded as a finding of the spec stage, not fixed here.
- The validator module `tools/scheduler/src/schema/validate.ts`: unchanged,
  including its error format.
- Documentation of the layout in `tools/README.md`: unchanged; it names the
  fields, not how they are checked.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use `loadRegistry` on a temporary directory as
`tools/scheduler/test/standing.test.ts` does today, with the known events
`['merge']` and the action kinds of `agents/actions.yaml` unless a
criterion says otherwise. "The fixture" is that test's definition text
(`name: test`, `trigger: {schedule: 1d, events: [merge]}`, `tier: strong`,
`worktree: none`, `profile: none`, `input: audit-input`,
`output: standing-result`). "The validator's message" for an error is the
string `validate` builds for it in `tools/scheduler/src/schema/validate.ts`:
the instance path (`/` at the root), the Ajv message and the error's
params as JSON, for example
`/ must NOT have additional properties {"additionalProperty":"unknown"}`.

- AC-1. **The schema is consulted first.** Given the fixture with a top-level
  key `unknown: true` in `test.md`, when the directory is loaded, then
  loading throws, the message starts with the file's path followed by `: `,
  and the rest of the message is the validator's messages for every error
  the schema reports, joined by `; ` (here exactly one:
  `/ must NOT have additional properties {"additionalProperty":"unknown"}`).
  The same holds for a missing required key (`/ must have required property
  'name' {"missingProperty":"name"}` when `name:` is removed), for
  `kind: wrong`, for `worktree: issue`, for `effort: 3`, for
  `name: Bad Name`, and for `profile: ''`. On `main` these failures are the
  hand checks' own messages (`unknown key unknown`, `name is required`,
  ...), so a test on any one of them distinguishes the two.
- AC-2. **The trigger's shape is the schema's.** Given the fixture with
  `trigger: {}`, `trigger: {schedule: 1d, foo: 1}`, `trigger: {events: []}`,
  `trigger: {schedule: soon}` or `trigger: [merge]`, when loaded, then
  loading throws with the file's path and the validator's message under
  `/trigger` (respectively `must NOT have fewer than 1 properties`,
  `must NOT have additional properties {"additionalProperty":"foo"}`,
  `/trigger/events must NOT have fewer than 1 items`,
  `/trigger/schedule must match pattern ...`, `/trigger must be object`).
- AC-3. **The loader keeps what the schema cannot say.** Given the fixture
  with `schedule: 1m` (under an hour) or `schedule: 31d` (over thirty days),
  then loading throws `trigger.schedule must be between 1h and 30d`; with
  `events: [oops]`, then `trigger.events unknown or empty`; with
  `actions: [oops]`, then `actions contains unknown kind`; with
  `profile: from-issue`, then `profile must be none or a profile name`;
  with `output: plan-result`, then `output must extend standing-result`;
  with `input: nope`, then `input schema missing`; with `tier: strong` and
  `fallback: other` and no `independent: true`, then the
  `sharedDefinitionChecks` message as today; with `name: other` in
  `test.md`, then `name must equal file name`. Each message is prefixed with
  the file's path as today. These checks run after the schema check, so a
  definition that fails both reports the schema's errors.
- AC-4. **A valid definition loads as before.** Given the fixture, when
  loaded, then the returned definition has the same fields and values as
  on `main` (the frontmatter's keys, `actions: []` when the key is absent,
  `prompt` equal to the body), and `renderStandingPrompt` over its prompt
  is unchanged. Given the fixture with `schedule: 1.5d`, `actions:
  [set_parameter]` (with that kind known), `effort: high`,
  `independent: true` or `fallback: other` with `tier: standard`, then it
  loads.
- AC-5. **The repository's agents pass the schema.** Given
  `agents/standing/` as checked in, the real `EVENT_NAMES` and the kinds of
  `agents/actions.yaml`, when loaded, then the registry holds exactly
  `action-audit` and `findings-filer` (the existing registry test), and
  `validate('standing-definition', <frontmatter>)` is `{ ok: true }` for each
  file's parsed frontmatter (a direct test in `schema.test.ts`, so the
  schema's own acceptance of the two files is asserted even if the loader
  changes).
- AC-6. **The schema rejects what the schema says.** Given the parsed
  frontmatter of the fixture, when `validate('standing-definition', fm)` is
  called on it, then it is `{ ok: true }`; and with each of the changes of
  AC-1 and AC-2 applied to that object, then `ok` is false and `errors`
  holds the messages those criteria name. Given `bounds` with a fourth key,
  a missing `max_turns` or `max_cost_usd: 0`, then `ok` is false
  (`/bounds must NOT have additional properties`, `/bounds must have required
  property 'max_turns'`, `/bounds/max_cost_usd must be > 0`).
- AC-7. **No hand check duplicates the schema.** Given the implementation
  PR's diff of `tools/scheduler/src/standing/registry.ts`, then
  `parseStandingDefinition` contains exactly one call of `validate` with
  `'standing-definition'`, placed before every other check of the
  frontmatter, and contains no list of allowed keys, no loop over required
  string keys, no `kind`, `worktree`, `effort`, `name`, `input` or `output`
  check, and no check of `trigger`'s type, keys, emptiness, or of
  `schedule` and `events`'s types; the checks AC-3 names are the ones that
  remain.
- AC-8. **The service fails as before.** Given a definition under the
  configured `agents/standing/` that the schema rejects, when the service
  starts, then it exits 78 with the loader's message in its log, as spec
  008 AC-1 says for a bad definition (no new test if the existing exit-78
  path is already covered; the loader's exception is the same one).
- AC-9. **The landed text follows.** Given the implementation PR's diff,
  then spec 008 AC-1 carries the mark of section 4 and no other line of
  spec 008 changes, and no text marked `(maintainer answer, question #<id>)`
  changes anywhere.

## 4. Amendments to earlier specs

- **Spec 008 AC-1** is amended: the frontmatter's shape (keys, required
  keys, enumerations, patterns, the `trigger` and `bounds` objects) is
  checked against `schemas/scheduler/standing-definition.json` before the
  loader's own checks, so the schema is the record of the shape and the
  loader checks only what the schema cannot express. What AC-1 says loading
  rejects is still rejected, with a message naming the file and the key.
  The mark is written in this spec's PR.

## 5. Interfaces and files

- `schemas/scheduler/standing-definition.json`: the same `$schema`, `$id`,
  `type`, `required` list and `additionalProperties: false` as today;
  `kind`, `harness`, `model`, `tier`, `permission`, `worktree`, `actions`,
  `fallback`, `independent` and `effort` as today; and these changes:
  - `name`, `profile`, `input`, `output`: `{"type": "string", "pattern":
    "^[a-z][a-z0-9-]*$"}` (the loader's regex; replaces `minLength: 1`).
  - `trigger`: `{"type": "object", "properties": {"schedule": {"type":
    "string", "pattern": "^\\d+(\\.\\d+)?[mhd]$"}, "events": {"type":
    "array", "items": {"type": "string"}, "minItems": 1}}, "minProperties":
    1, "additionalProperties": false}`. The pattern is `parseDuration`'s
    syntax; the range stays in code. `minProperties: 1` with the closed key
    set says "schedule or events, or both" (spec 008 AC-1); when spec 028
    adds `min_events` it also adds its "only with `events`" rule, for
    example with `dependentRequired`.
  - `bounds`: `{"type": "object", "properties": {"timeout_min": {"type":
    "number", "exclusiveMinimum": 0}, "max_turns": {"type": "number",
    "exclusiveMinimum": 0}, "max_cost_usd": {"type": "number",
    "exclusiveMinimum": 0}}, "required": ["timeout_min", "max_turns",
    "max_cost_usd"], "additionalProperties": false}` (what
    `sharedDefinitionChecks` and `isBounds` enforce).

  This schema compiles under the validator's `Ajv2020({ allErrors: true,
  strict: true })` and accepts both repository definitions (checked while
  writing this spec).
- `tools/scheduler/src/standing/registry.ts`, `parseStandingDefinition`:
  after `splitFrontmatter` and `parse`, call
  `validate('standing-definition', fm)` (imported from
  `../schema/validate.ts` beside `schemaDir`) and throw
  `new Error(v.errors.join('; '))` when it is not ok. Remove the hand checks
  AC-7 names. Keep, in this order: `sharedDefinitionChecks(fm)`; the
  schedule range (`parseDuration(t.schedule)` between `3600000` and
  `30*86400000` when `schedule` is present, message unchanged); the event
  names (message unchanged); the action kinds (message unchanged; `actions`
  defaults to `[]`); `profile !== 'from-issue'` (message unchanged); the
  `output` extends `standing-result` check and the `input` schema existence
  check (unchanged). `loadRegistry`, `parseDuration` and
  `renderStandingPrompt` are unchanged. `SchemaName` already includes
  `standing-definition`; `validate.ts` is not edited.
- `tools/scheduler/src/stages/definition.ts`: unchanged.
  `parseAgentDefinition` still routes `kind: standing` to
  `parseStandingDefinition` after its own mapping check.
- `tools/scheduler/test/standing.test.ts`: the rejection table at line 34
  keeps its cases and gains the cases of AC-1 to AC-3 that it lacks, with
  the expected messages asserted (not only `/test.md/`), so AC-1's
  distinction from `main` is pinned; AC-4's acceptance cases; the existing
  registry test over `agents/standing/` stands for AC-5's first half.
- `tools/scheduler/test/schema.test.ts`: a `describe('standing definition
  schema')` block for AC-5's second half (parse each `agents/standing/*.md`
  frontmatter with `splitFrontmatter` and `yaml`'s `parse`, expect
  `validate('standing-definition', fm).ok`) and AC-6.
- `specs/008-agent-registry/spec.md` AC-1: the mark of section 4, written in
  the spec PR (AC-9 checks it is still there).

The spec PR itself adds
`specs/041-registry-validates-standing-definitions/spec.md`, lists this
spec under `## Children` in `docs/delivery-system-design.md`, and prepends
the mark `Amended by [041-registry-validates-standing-definitions](../041-registry-validates-standing-definitions/spec.md) AC-7: the frontmatter's shape is checked against standing-definition.json before the loader's own checks.`
to spec 008 AC-1.

`tools/scheduler/` and `schemas/` are sensitive paths
(`agents/sensitive-paths.txt`); the security review applies to the
implementation PR (spec 006 AC-9). The change touches no gate, bound, label
rule or permission. The property worth the reviewer's glance: every
rejection the loader makes today is still made (by the schema or by the
remaining checks, AC-1 to AC-3), so no definition that `main` refuses
loads after the change.

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test for `unknown: true` fails on `main` (the message there is
  `unknown key unknown`) and passes after the change; the AC-6 test for
  `trigger: {schedule: 1d, foo: 1}` against `validate` fails on `main` (the
  schema there accepts any object as `trigger`) and passes after.
- `grep -c "validate('standing-definition'" tools/scheduler/src/standing/registry.ts`
  (or with double quotes) prints 1; `grep -n "unknown key" tools/scheduler/src/standing/registry.ts`
  finds nothing.
- The scheduler's own start-up, in a checkout with `agents/standing/` as
  checked in, loads the registry without error (the existing registry test
  and the e2e tests exercise it).
- `git diff main -- specs/008-agent-registry/spec.md` shows only the mark on
  AC-1.

## 7. Open decisions

None.
