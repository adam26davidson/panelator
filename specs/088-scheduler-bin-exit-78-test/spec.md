# 088. A test runs `bin/scheduler.ts` through its exit-78 configuration-error path

Status: written 2026-11-19 from the delivery-system design for issue #175;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design); `tools/scheduler/systemd/panelator-scheduler.service`
(`RestartPreventExitStatus=78`, the unit setting the exit status serves);
[008-agent-registry](../008-agent-registry/spec.md) AC-1 (a bad standing
definition: "the service exits 78 as it does for a bad config");
[027-metrics](../027-metrics/spec.md) AC-1 (a bad metric definition: "the
service exits 78 as for a bad config");
[041-registry-validates-standing-definitions](../041-registry-validates-standing-definitions/spec.md)
AC-1 (the `unknown: true` fixture and its message) and AC-8 (the service
fails as before, "no new test if the existing exit-78 path is already
covered"). This spec changes none of those specs' text: it adds the test
their criteria assumed.

## 1. Goal

The service entry point `tools/scheduler/bin/scheduler.ts` has an automated
check of the contract four places state: a configuration error the service
cannot recover from by restarting writes a `config-error` record to the
service log, prints the reason on stderr and exits with status 78, so the
systemd unit's `RestartPreventExitStatus=78` ends the restart loop instead of
restarting into the same error.

### What is missing today

`fail()` (bin/scheduler.ts lines 53-58) and the block it wraps (lines 60-66:
`registryActionsCheck`, `loadRegistry`, `loadParameterDefinitions`,
`loadCatalogue`, `loadActionLevels`, `loadMetricDefinitions`) are reached by
no test. Each loader is tested directly, but the wrapper that turns their
exceptions into the exit status is not, so a refactor that let an exception
escape (Node exits 1, and systemd restarts the service forever) or that
dropped the log record would pass `pnpm test`. Spec 041 AC-8 relied on an
existing test of this path; none exists, and its implementation (PR #168)
added none.

One test does spawn the bin: the e2e test of the `action undo` command
(`tools/scheduler/test/e2e.test.ts`, the standing-agents block) runs
`bin/scheduler.ts action undo <id> --config <file>` and checks its JSON
output. It runs against the repository's own `agents/` and exits through the
command branch, so it never reaches `fail()`. The issue's grep for
`bin/scheduler` missed it because the path is built with `join`.

### Why the test cannot be written today

The bin loads its definitions from `agentsDir`, a constant in
`tools/scheduler/src/config.ts` fixed to the repository's `agents/`. A test
cannot put a bad definition there without editing the checked-in tree, which
races every other test that reads it. The config path and state directory are
already chosen by `--config`; the agents directory is not.

### The fix

1. **A `--agents-dir <path>` flag on the bin** *(agent's call)*. The bin
   reads its agents directory as `flag("--agents-dir") ?? agentsDir` and uses
   that value everywhere it uses `agentsDir` today (the loaders, the
   credential profiles, the stage definitions and the `agentsDir` it hands
   the `Scheduler`). Without the flag nothing changes: the systemd unit does
   not pass it, and `config.ts`'s exported `agentsDir` stays as it is.
   Reasons for a flag over the issue's other two options: a config key
   (`agents_dir` in `agents/scheduler.yaml`) would make the agents directory
   a deployment setting, which it is not (the service's restart rule watches
   `agents/` in the checkout it runs from); an environment variable is
   inherited by every stage and standing run the service spawns, where a
   flag stays in the one process. The flag mirrors `--config`, which tests
   already pass.
2. **A spawn test, `tools/scheduler/test/bin.test.ts`.** It copies the
   repository's `agents/` into a temporary directory, writes a config file
   whose `state_dir`, `credentials.dir` and `telegram.credentials_path` lie
   under the test's temporary directory, breaks one file of the copied tree
   per case, runs `node bin/scheduler.ts --config <file> --agents-dir <dir>`
   and asserts the exit status, the stderr line and the service-log record.
   Temporary directories come from the run's `TMPDIR` root that
   `test/helpers/test-tmpdir.ts` sets up, which the child inherits.

## 2. Out of scope

- The other `fail()` calls after loading (no App key, a checkout not on
  `main`, a non-https origin) beyond the one AC-3 uses as its stopping
  point: each needs a git checkout or a key and adds nothing about the
  wrapper that AC-1 and AC-2 do not already check.
- The order the loaders run in. Each depends on the one before it
  (`loadRegistry` takes the action kinds, `loadParameterDefinitions` and
  `loadCatalogue` take the registry), so the order is fixed by the data flow;
  the test checks that every loader's failure is caught, not which of two
  failures is reported first.
- Any change to the loaders, their messages, `fail()` itself or the systemd
  unit. If the test shows the bin does not meet AC-1 to AC-3, the
  implementation fixes the bin so it does, within `tools/scheduler/bin/`.
- Making the bin importable (moving its top-level work into a function).
  A spawn test checks the real entry point as systemd runs it; restructuring
  the file is a larger change the issue does not ask for.
- Specs 008, 027 and 041: their criteria already say what this test checks,
  so none is amended or marked.

## 3. Acceptance criteria

- AC-1. **A bad standing definition stops the service with 78.** Given a
  copy of the repository's `agents/` in which
  `standing/findings-filer.md` carries an extra top-level frontmatter line
  `unknown: true` (spec 041 AC-1's fixture), and a config file whose state
  and credential paths lie under the test's temporary directory, when
  `bin/scheduler.ts --config <file> --agents-dir <copy>` runs, then it exits
  with status 78; its stderr holds a line starting
  `panelator-scheduler: <copy>/standing/findings-filer.md: ` and containing
  `must NOT have additional properties`; and the last record of the service
  log (`<state_dir>/log/service.jsonl`) has `kind: "config-error"` and a
  `reason` equal to that stderr line without its `panelator-scheduler: `
  prefix. (Checked by hand while writing this spec, with a throwaway copy of
  the bin carrying the flag: status 78, reason
  `<copy>/standing/findings-filer.md: / must NOT have additional properties {"additionalProperty":"unknown"}`.)
- AC-2. **Every wrapped loader's failure is caught.** Given the same setup
  with, instead of the bad definition, one of these breakages, when the bin
  runs, then it exits 78 with a `config-error` record whose `reason` matches
  its stderr line, as in AC-1:
  - `actions.yaml` broken (`registryActionsCheck`, the first loader);
  - `parameters.yaml` broken (`loadParameterDefinitions`);
  - `credentials.yaml` broken (`loadCatalogue`);
  - one definition under `metrics/` broken (`loadMetricDefinitions`).
  The test is one parameterised case per breakage. The exact breakage of
  each file is the implementer's choice, taken from a rejection that the
  direct test of that loader already asserts, and the case asserts a
  fragment of that loader's message in the `reason` (so a case cannot pass
  on some other loader's error).
- AC-3. **A valid tree loads and reaches the service checks.** Given an
  unmodified copy of `agents/` and a config with `app.id: 0` and
  `app.installation_id: 0`, when the bin runs with no command, then it gets
  past the loading block, `initializeAgents` and the action log's
  stale-pending sweep, and stops at the App-ids check: exit 78, stderr
  `panelator-scheduler: GitHub App ids not set in agents/scheduler.yaml`, a
  matching `config-error` record, and one state file per standing agent of
  the copy under `<state_dir>/agents/` (`<name>.json`). No network request is
  made and no file outside the test's temporary directory is written.
  (Today's bin already behaves so without the flag, checked by hand while
  writing this spec.)
- AC-4. **The flag changes nothing when absent.** Given no `--agents-dir`,
  then the bin loads from `agentsDir` of `tools/scheduler/src/config.ts` as
  before: the existing e2e `action undo` spawn passes unchanged, and
  `tools/scheduler/systemd/panelator-scheduler.service` is not edited.
- AC-5. **The tests stay inside their budget.** Each spawn case finishes
  within vitest's per-test timeout set in the file (at most 30 s per case),
  and the file leaves nothing behind once the run's temporary root is torn
  down.

## 4. Interfaces and files

- `tools/scheduler/bin/scheduler.ts`: the `--agents-dir <path>` flag
  (section 1, fix 1); a one-line comment beside it saying the flag exists for
  tests and the default is the checkout's `agents/`. No other change unless
  AC-1 to AC-3 fail against today's bin.
- `tools/scheduler/test/bin.test.ts` (new): the cases of AC-1 to AC-3, with a
  helper that copies `agents/`, writes the config (JSON is valid YAML, as the
  e2e test's `cli-config.json` already relies on), spawns the bin with
  `process.execPath` and returns `{status, stderr, serviceLog}`.
- No change to `tools/scheduler/src/config.ts`, the loaders, `schemas/` or
  `agents/`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9).

## 5. Verification

`pnpm test` from the repository root runs `bin.test.ts` with the rest of the
scheduler suite. Reviewing the test against AC-1 to AC-3 checks that it
asserts the status, the stderr line and the log record, not only one of
them. A manual mutation shows the test bites: with `fail()`'s
`process.exit(78)` changed to `process.exit(1)`, or the `catch` around the
loading block removed, AC-1 and AC-2 fail.

## 6. Open decisions

None.
