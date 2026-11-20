# 083. Refused contacts and removed parties are recorded in the contacts log, not the action log

Status: written 2026-11-18 from the delivery-system design for issue #170;
specs derived from that design need no maintainer approval (design section 11).
Amends [030-beyond-github](../030-beyond-github/spec.md) AC-11, AC-12, section 5
and section 6, whose text carries the marks of section 4.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design), section 6.2 (level 1 is the direct action; "every direct action
is recorded: what, why, which agent, and how to undo it"; the action audit
reviews the log kind by kind), section 8 ("First contact") and section 2
(anti-goal: no contact with a new outside party without approval);
[008-agent-registry](../008-agent-registry/spec.md) AC-8 (every action kind is
defined in `agents/actions.yaml` and in code, cross-checked by the registry
test), AC-9 (the action log's fields and its one writer) and AC-23 (the
action audit's input is the log grouped by kind);
[030-beyond-github](../030-beyond-github/spec.md) AC-8 (an approval appends
the party to `contacts/parties.json`), AC-11 (the gate), AC-12 (the
`contacts` commands; no action kind writes `contacts/parties.json`) and
section 5; [038-param-mode-leaves-the-action-log](../038-param-mode-leaves-the-action-log/spec.md)
section 1 (a maintainer-only change that no kind may make is recorded beside
its own state, not in the action log), AC-4 (`applyAction` is the log's only
writer), AC-5 (every effect row names a defined kind) and section 2 (this
gap, left to a finding).

## 1. Goal

Spec 030 records two things in the action log under kinds that
`agents/actions.yaml` does not define. This spec moves both records into the
contacts state spec 030 already owns, before spec 030's contacts half is
built (issue #39), so the action log keeps spec 038's rules: one writer,
`applyAction`, and every effect row under a defined kind.

### What is wrong in spec 030

- AC-11: "A refused call is recorded in the action log (`agent: <stage or
  agent>`, `kind: contact_refused`, `status: refused`, the party and the
  command without its body) so the action audit and the console can see
  attempts." No `contact_refused` kind exists, and section 5 places the
  writer under `tools/scheduler/src/actions/` while saying
  `agents/actions.yaml` gains only `renew_credential`.
- AC-12: "`contacts remove <party>` deletes an entry and is logged as
  `maintainer`." The only maintainer rows in the action log are written
  through `applyAction` by a defined kind (spec 008 AC-9, spec 038 AC-4,
  spec 069 AC-10), and AC-12's own last sentence says no action kind writes
  `contacts/parties.json`.

Built as written, either would be a second writer of the log (spec 038 AC-4's
test fails) or a kind with no definition in the audit's per-kind grouping
(the defect spec 038 fixed for `parameter_mode`): an action-audit finding
"move action kind contact_refused to level 2" would name a kind that does
not exist.

### The fix

Neither record is a direct action. A refused contact applies nothing, has no
undo and no level: it is the first-contact gate doing its job, and design
section 6.2 reserves the action log for what the system may do and undo.
Removing an approved party is the maintainer's alone, and spec 030 AC-12
already rules out any action kind touching the list, the same shape as spec
008 AC-12's "no action kind sets a mode" that spec 038 followed. So both are
recorded beside the list they concern: `contacts/log.jsonl` in the state
directory, an append-only log of the first-contact gate, one line per
refused call and one per removed party (AC-1 to AC-3). The action log is
untouched by the contacts code, and `agents/actions.yaml` gains no kind.
The maintainer reads the log with `panelator-scheduler contacts log`
(AC-4).

The two other fixes the issue names, and why not:

- *Define a kind for each and route the writes through `applyAction`.* A
  `contact_refused` kind would apply nothing; its row would read `applied`
  for a call that was refused, or `refused` for a request no agent made, and
  the audit could only ever propose moving it to level 2, which means
  nothing for a gate that is code under a locked parameter. A
  `contacts_remove` kind contradicts spec 030 AC-12's rule that no kind
  writes `contacts/parties.json`, and its undo would re-add a party, an
  approval made by the system. Spec 069 made the `cred` commands kinds; that
  does not carry over, because no rule keeps action kinds away from the
  credential store, while one does for the parties list.
- *Record them in the event store of spec 026.* Spec 068 (spec 030's
  follow-up) records `maintainer.contact` events, contacts *with the
  maintainer*; a refused call is not one, so this would add an event kind to
  a schema those specs own, for records only the gate writes and only the
  contacts commands read. The `contacts/` directory is spec 030's, the gate
  already reads it on every call, and a JSONL file beside the list keeps the
  gate's code in one place.

The action audit does not receive the contacts log. Its job is to find
action kinds that go wrong and move them to level 2 (spec 008 AC-23); a
refused contact is not a kind it could move. A stage that is refused is told
to ask a capability question (spec 030 AC-11), which is how a needed contact
reaches the maintainer; the log is the record of the attempts.

No ADR: the decision is small (where two records go in a spec not yet
built), follows from spec 038 and spec 030 AC-12 as written, and reverses
nothing recorded.

## 2. Out of scope

- The gate's decision itself (`checkContact`, the `gh` shim's list of
  creating calls, `first_contact_needs_approval`), the approval of spec 030
  AC-8 and its `maintainer.contact` event of spec 068 AC-3, and `contacts
  list`: unchanged.
- `agents/actions.yaml`, the kinds table, `applyAction`, the action log and
  the action audit with its input builder: unchanged. No kind is added.
- A notification or finding on a refusal: none. The refused stage asks; the
  log is for the record.
- Recording approvals in `contacts/log.jsonl`: the approval is already in
  `contacts/parties.json`, the question log's `outcome` (spec 030 AC-8) and
  spec 068's event; a removal line carries the removed entry (AC-2), so the
  approval's record outlives the removal.
- A console view of the log: the console (spec E, ADR 0005) may read the
  file when it is built; this spec adds none.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory as in
`tools/scheduler/test/actions.test.ts`. AC-1 and AC-2 are what spec 030
AC-11 and AC-12 now require of the gate and the `contacts remove` command;
they are tested where spec 030 builds those (`contacts.test.ts`). AC-3 to
AC-5 are the pieces this spec's implementation builds, which spec 030's
contacts half calls. If spec 030's contacts half is built first, its PR
builds AC-3 to AC-5 as given here and this spec's implementation adds only
what is missing.

- AC-1. **A refused call is a line in the contacts log.** Given
  `first_contact_needs_approval` is `true` and `contacts/parties.json` has
  no `github:other`, when the `gh` shim runs `gh issue create -R other/repo
  --title T --body B` in a run whose environment has `PANELATOR_ACTOR=implement`
  and `PANELATOR_RUN_ID=r1` (AC-5), then the shim exits 1 with spec 030
  AC-11's text and makes no API call, exactly one line is appended to
  `contacts/log.jsonl`, `{ at, event: "refused", actor: "implement", run_id:
  "r1", party: "github:other", command }`, where `command` is the argv
  after `gh` with the value of every content-carrying flag (`--body`, `-b`,
  `--body-file`, `--title`, `-t`, `--field`, `-f`, `--raw-field`, `-F`,
  `--input`) replaced by `<omitted>`, and `actions/log.jsonl` is unchanged
  (it does not exist, or has exactly the lines it had before). An allowed
  call writes no line. Given the line cannot be written, then the refusal
  still stands (exit 1, no call) and the shim adds `contacts log not
  written: <reason>` to its stderr: the gate fails closed.
- AC-2. **A removal is a line in the contacts log.** Given
  `contacts/parties.json` holds `github:other`, when `panelator-scheduler
  contacts remove github:other` runs, then the entry is gone from the list,
  exactly one line `{ at, event: "removed", actor: "maintainer", party:
  "github:other", entry }` is appended to `contacts/log.jsonl`, with `entry`
  the removed entry as it stood (`party`, `channel`, `approved_at`,
  `question_comment_id`, `issue`), the command prints `entry` as one line of
  JSON and exits 0, and `actions/log.jsonl` is unchanged. Given a party not
  in the list, then the command exits 1 with `unknown party <party>` and
  neither file changes.
- AC-3. **The log has one shape and one writer.** `appendContactLog(paths,
  line)` in `tools/scheduler/src/contacts/log.ts` validates the line against
  `schemas/scheduler/contacts-log-entry.json` (a `oneOf` of the two shapes of
  AC-1 and AC-2; `actor` and `run_id` strings, `run_id` `null` allowed;
  `at` an ISO time) and appends it as one JSON line; given a line that fails
  the schema, it throws and writes nothing. Nothing rewrites or deletes
  earlier lines. A test under `tools/scheduler/test/` reads
  `tools/scheduler/src/**/*.ts` and `tools/scheduler/bin/*` and asserts that
  `contacts/log.jsonl` is written only by `src/contacts/log.ts` (no other
  file names `paths.contactsLog` with a write call), in the style of spec
  038 AC-4.
- AC-4. **The maintainer reads the log.** `panelator-scheduler contacts log
  [--since <time>]` prints the lines of `contacts/log.jsonl` at or after
  `--since` (all of them without it) as a JSON array, as `action list
  [--since <time>]` prints the action log, through
  `readContactLog(paths, since?)` in `src/contacts/log.ts`; a missing file
  prints `[]`. It writes nothing.
- AC-5. **A run's environment names its actor.** Given a chain stage run or
  a standing agent run, then the environment the runner gives the agent
  (and so the `gh` shim) carries `PANELATOR_ACTOR` (the stage name, or the
  standing agent's name) and `PANELATOR_RUN_ID` (the run's id). Given the
  shim runs without them (the maintainer by hand), then the refused line has
  `actor: "unknown"` and `run_id: null`. The agent controls its own shell,
  so the two fields are what the run said, not proof of who ran the call;
  the log is a record of attempts, not an access control. A test asserts
  both variables in a stage run's environment and a standing run's.
- AC-6. **No contacts kind exists.** Given the implementation, then
  `agents/actions.yaml` and `KINDS` in `src/actions/index.ts` have no kind
  whose name contains `contact`, `grep -rn contact_refused tools/scheduler
  agents schemas` finds nothing, and spec 038 AC-4's test (only
  `applyAction` writes the action log) and spec 030 AC-12's test (no kind
  writes `contacts/parties.json`) pass unchanged.

## 4. Amendments to earlier specs

Each is marked on spec 030's text in this spec's PR.

- **Spec 030 AC-11**, its sentence on the refused call. It reads as AC-1
  here: a refused call is one `refused` line in `contacts/log.jsonl`
  (actor and run id from AC-5, the command with content flags omitted)
  written through `appendContactLog`; it is not written to the action log,
  and the action audit does not receive it (section 1). The rest of AC-11
  stands.
- **Spec 030 AC-12**, "is logged as `maintainer`". It reads as AC-2 here:
  `contacts remove` appends one `removed` line with `actor: maintainer` and
  the removed entry to `contacts/log.jsonl`, not to the action log; and
  `contacts log` of AC-4 joins `contacts list` and `contacts remove`. The
  rule that no action kind writes `contacts/parties.json` stands.
- **Spec 030 section 5.** The `tools/scheduler/src/actions/` bullet loses
  "`contact-refused` log entries (AC-11)"; `src/contacts/` gains `log.ts`
  (AC-3, AC-4); `src/state/paths.ts` gains `contactsLog`
  (`contacts/log.jsonl`); `schemas/scheduler/` gains
  `contacts-log-entry.json`; `src/runner/run.ts` and `src/standing/run.ts`
  set the variables of AC-5; `tools/README.md` documents `contacts log`.
- **Spec 030 section 6.** The recorded first-contact run's "one
  `contact_refused` log entry" reads "one `refused` line in
  `contacts/log.jsonl` and no new action-log row".

## 5. Interfaces and files

This spec's implementation:

- `tools/scheduler/src/contacts/log.ts`: `ContactLogLine` (the two shapes),
  `appendContactLog(paths, line)`, `readContactLog(paths, since?)` (AC-3,
  AC-4). It imports nothing from `src/actions/`.
- `tools/scheduler/src/state/paths.ts`: `contactsLog`, the path
  `contacts/log.jsonl` under the state directory (the directory created on
  first write).
- `schemas/scheduler/contacts-log-entry.json` (AC-3).
- `tools/scheduler/src/runner/run.ts` and `tools/scheduler/src/standing/run.ts`:
  `PANELATOR_ACTOR` and `PANELATOR_RUN_ID` in the agent's environment
  (AC-5).
- `tools/scheduler/bin/scheduler.ts`: the `contacts log [--since <time>]`
  branch (AC-4), beside which spec 030 adds `contacts list` and `contacts
  remove`; the usage line names it.
- `tools/scheduler/test/contacts-log.test.ts`: AC-3 to AC-5 and the AC-6
  grep.
- `tools/README.md`: one line for `contacts log`.

Spec 030's contacts half, as amended, then: `src/contacts/gate.ts` calls
`appendContactLog` on a refusal (AC-1); `src/contacts/commands.ts`'s
`remove` calls it after removing the entry (AC-2); `contacts.test.ts` and
the recorded run of section 6 assert the lines and the unchanged action log.

The spec PR itself adds this file, marks spec 030 AC-11, AC-12, section 5
and section 6 as section 4 gives them, and lists this spec under
`## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). The change
touches no gate's decision, bound, label rule or permission:
`first_contact_needs_approval`, the parties list and `checkContact`'s
answer are as spec 030 gives them, a refusal stands even when its record
cannot be written (AC-1), and the action log keeps one writer.

## 6. Verification

- `pnpm test` from the repository root passes, including
  `contacts-log.test.ts` (AC-3 to AC-6) and spec 038's writer test.
- `grep -rn contact_refused tools/scheduler agents schemas` finds nothing.
- `git diff main -- specs/030-beyond-github/spec.md` in the spec PR shows
  only the four marks of section 4.
- When spec 030's contacts half lands, its `contacts.test.ts` and the
  recorded first-contact run assert AC-1 and AC-2; live, after deploy, a
  `gh issue create -R` against a repository of an unapproved owner, run by
  hand with the shim on `PATH`, is refused and `panelator-scheduler contacts
  log --since <a minute ago>` shows one `refused` line with `actor:
  "unknown"`, while `action list --since <a minute ago>` shows no row.

## 7. Open decisions

None.
