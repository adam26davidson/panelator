# 008. Agent registry, direct actions, parameter store and findings filer

Status: written 2026-10-27 from the delivery-system design (spec C); specs
derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 6.1, 6.2, 9 ("Parameters at the start"), 11 (row C) and 13;
[charter](../../docs/charter.md) (parameters auto or locked; the system adds
agents itself); [process-spec](../../docs/process-spec.md) sections 4.2, 4.3,
4.4 and 4.5; [ADR 0001](../../docs/decisions/0001-harness-per-model-vendor.md);
amends [001-scheduler-core](../001-scheduler-core/spec.md) section 7 (the
2:1 ratio) and section 11 (state directory), and
[006-no-human-stops](../006-no-human-stops/spec.md) section 2 (the queue now
has a consumer; abandoned issues are re-triaged).

What the maintainer decided (design sections 6.2 and 9), kept as it is here:
agents act directly on operational, reversible actions within limits that
already exist; anything that changes repository content goes through a
reviewed PR, and bigger directional changes carry a design write-up in the
PR; the system adds new agents itself, without approval; each parameter is
auto or locked, and a locked parameter cannot be changed by the system.

## 1. Goal

Give the scheduler the standing agents the design describes, and the two
mechanisms they act through:

- **A registry.** A file under `agents/standing/` defines one standing agent:
  its trigger (a schedule or events), harness, model, bounds, input and
  output schemas, and the direct actions it may take. Adding a file adds an
  agent; the scheduler runs it in a concurrency slot when it is due.
- **Direct actions (level 1).** A standing agent's result may carry actions.
  The scheduler applies each one in code, refuses what the limits forbid, and
  records every one in an action log with what, why, which agent and how to
  undo it. Undo is a command.
- **A parameter store.** Each parameter is `auto` or `locked`. The system
  changes an `auto` parameter through a direct action; a `locked` parameter is
  refused in code. The mode is the maintainer's alone. The system-vs-product
  work share is a parameter, and the shortlist ranks by it instead of the
  fixed 2:1 feature-to-debt ratio.
- **Two agents on the roster.** The **findings filer** consumes the findings
  queue: it files validated bot issues, discards with a reason, routes
  security findings away from the public tracker, and turns a possible design
  flaw into an issue the spec stage takes to the question check. It also
  re-triages issues labelled `abandoned`, which is the recovery path spec 006
  left open. The **action audit** reads the action log and files findings
  about kinds of action that go wrong, so a kind can be moved to level 2.

## 2. Out of scope

- The event store, metrics and the three reflection agents (spec D). The
  action log, the parameter history and the agent run records this spec
  writes are raw events D will read; nothing here aggregates them.
- The console (spec E): its Actions, Agents and Parameters screens show and
  set what this spec stores. Until E lands, the maintainer sets and locks
  parameters, undoes actions and pauses agents with the scheduler's command
  line on the laptop (AC-11, AC-17).
- The infra health and credential check agents, the credential store, AWS
  operations (restart a service, scale resources) and the AWS cap's
  enforcement (specs F1 and F2). The cap exists here only as a locked
  parameter with no consumer; the `infra_alarm` and `credential_expiry`
  trigger events are reserved names with no producer yet.
- Telegram alerts for security findings (spec F2 routes the `Notifier`); here
  the notification goes to the service log as every notification does.
- Intake and grilling, the authority rule, and community issues: unchanged.
- Changing the issue chain's stages, bounds or transitions (spec 006 section
  4). A standing agent is not a chain stage.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
Standing agents run through the same adapters, runner, bounds and usage
records as chain stages.

**Registry** (design section 6.1)

- AC-1. **A standing agent is a file.** `agents/standing/<name>.md` has YAML
  frontmatter and a prompt body, parsed by the stage-definition loader:
  `name` (equal to the file name), `kind: standing`, `trigger`, `harness`,
  `model`, optional `fallback`, `tier`, optional `effort`, `bounds`
  (`timeout_min`, `max_turns`, `max_cost_usd`), `permission: no-prompt`,
  `worktree` (`fresh`: a clean worktree of `origin/main`; `none`: the
  repository checkout, read-only), `profile` (`none` or a profile name),
  `input` and `output` (schema names under `schemas/scheduler/`; the output
  schema must extend `standing-result`, AC-5), `actions` (the action kinds the
  agent may request, a subset of `agents/actions.yaml`, AC-8; default none),
  and optional `independent`. `trigger` is one of:
  - `{ schedule: "<every>" }`, an interval such as `1d`, `7d`, `12h`, at
    least `1h`;
  - `{ events: [<name>, ...] }`, from the event names of AC-4;
  - both keys, for an agent woken by events and swept on a schedule.

  The prompt body may use the placeholders `{{agent}}`, `{{events}}`
  (the pending events of AC-4 as JSON), `{{since}}` (the last run's time),
  `{{parameters}}` (the parameter store as JSON), `{{result_path}}` and
  `{{profile_instructions}}`. Given a file with an unknown key, a missing
  required key, an interval under an hour, an unknown event name, a
  strong-tier `fallback` without `independent`, or an action kind not in
  `agents/actions.yaml`, then loading fails with a message naming the file
  and the key, and the service exits 78 as it does for a bad config. The
  same checks run as a vitest test over the repository's `agents/standing/`.
- AC-2. **Adding a file adds an agent.** Given a merge on `main` that adds,
  changes or removes a file under `agents/standing/`, then the service
  restarts after in-flight runs finish (as it does today for `agents/`) and
  the registry is reloaded; a new agent with a schedule is first due one
  interval after the restart, and its schedule parameter (AC-13) is created.
  Given a removed file, then its state file and schedule parameter are kept
  for 30 days, then pruned, so a re-added agent resumes its history.
- AC-3. **A due agent runs in a slot.** The scheduler keeps
  `agents/<name>.json` in the state directory: `last_run` (time, run id,
  outcome), `next_run`, `pending_events`, `paused` and `paused_by`, and the
  consecutive failure count. Given a tick, then after the resumes of spec 006
  AC-15 and before the shortlist, each agent that is due (`next_run` has
  passed, or `pending_events` is not empty), not paused, and not running
  takes a free slot, oldest `next_run` first. A run uses the agent's bounds,
  a fresh session, its own run id and usage record (the record's `stage`
  field accepts a standing agent's name), and the retry and fallback rules
  of spec 001 AC-25 and spec 006 AC-26. Given the run succeeds, then its
  result is applied (AC-5), `last_run` and `next_run` (now plus the schedule
  interval, from the schedule parameter) are written, and the events it
  received are cleared. Given it fails, then it is retried once at the next
  tick; a second failure writes `last_run` with the outcome, schedules the
  next run as if it had succeeded, appends one finding naming the agent and
  the error, and sends one notification. An agent whose schedule was missed
  (the laptop slept) runs once, not once per missed interval. (Amended by
  spec 013 AC-7: a run that hits a quota or rate limit is not a failure and
  is not retried at the next tick; the agent is postponed to the limit's
  reset, keeping its failure count and pending events. Amended by spec 025
  section 4: a `finding_queued` event alone makes an agent due only once
  `standing.event_debounce` has passed since its last run, and a first attempt
  ending `result: invalid` gets one repair turn before it counts as a failure.)
- AC-4. **Events wake agents.** The scheduler emits these events in code,
  each with a payload: `merge` (an issue PR or spec PR merged: issue, PR,
  SHA), `finding_queued` (lines appended to the findings queue: the count),
  `issue_abandoned` (spec 006 AC-5: the issue), `maintainer_reply` (spec 006
  AC-15: the issue, the question id), and `ci_failure_main` (a required check
  on the head of `main` went from passing or absent to failed since the last
  tick: the check name, the run id, the SHA; the last seen state is kept in
  the state directory so a restart does not repeat it). `infra_alarm` and
  `credential_expiry` are valid names with no producer (section 2). Given an
  event, then it is appended to `pending_events` of every agent that
  subscribes to it, before the action that caused it completes (the merge's
  record, the queue append, the abandonment's actions), so a crash does not
  lose it; a redelivered event with the same payload is kept once. An agent
  runs once for all its pending events and receives them as `{{events}}`.
- AC-5. **A result is applied by the scheduler.** `standing-result` is `{
  summary: string, actions?: [Action], findings?: [Finding] }`; an agent's
  own output schema adds fields to it. Given a valid result, then its
  findings go to the findings queue (spec 001 AC-28), its actions are
  applied in order (AC-8), and the summary is written to the agent's state
  file and the run record. A result that does not validate is a failed run.
  A standing agent never posts to GitHub itself: the filer's issues (AC-20)
  and advisories (AC-22) are created by the scheduler from the result, so
  everything it files appears as the App's bot user and the authority rule of
  process-spec 4.3 keeps holding.
- AC-6. **An agent can be paused.** Given `pause_agent` (an action, or the
  command `panelator-scheduler agent pause <name>`), then `paused: true` and
  `paused_by` (the agent, or `maintainer`) are written and the agent is not
  run while paused; its events still accumulate. `resume_agent` clears it.
  Given an agent paused by the maintainer, then a `resume_agent` action from
  the system is refused (AC-9), as a locked parameter is; only the command
  resumes it. `panelator-scheduler agent list` prints each agent with its
  last run, next run, paused state and pending event count; `agent run
  <name>` marks it due now.
- AC-7. **One run at a time, and the chain is untouched.** Given an agent is
  running, then it is not started again until that run ends, whatever its
  trigger. Given no standing agent is due, then a tick behaves exactly as
  before this spec: the recorded chains of spec 006 AC-28 and spec 007 pass
  unchanged with the registry loaded.

**Direct actions** (design section 6.2)

- AC-8. **Actions are kinds defined in code.** `agents/actions.yaml` lists
  every action kind with `level` (`1` or `2`) and a one-line description; the
  kinds and their arguments, checks, effects and undos are code in
  `tools/scheduler/src/actions/`, and a kind in the file with no code, or
  code with no entry, fails the registry test of AC-1. The kinds this spec
  ships, all level 1:
  - `set_parameter` `{ name, value }`: sets an `auto` parameter within its
    definition's type and range (AC-11); undo restores the previous value;
  - `pause_agent` `{ name }` and `resume_agent` `{ name }` (AC-6): each is
    the other's undo;
  - `run_agent` `{ name }`: marks a standing agent due now; undo clears that
    mark if it has not run yet;
  - `rerun_workflow` `{ run_id }`: re-runs one GitHub Actions workflow run of
    this repository, at most once per run id per day; undo cancels the
    re-run if it is still queued or in progress;
  - `undo` `{ action_id }`: applies the recorded undo of an earlier applied
    action (AC-10).

  An `Action` in a result is `{ kind, args, why }` with `why` at least 20
  characters. Given a kind not in the file, or not in the agent's `actions`
  list, or with level 2, or with arguments that fail the kind's checks, then
  it is refused: nothing is applied, the refusal is logged (AC-9) with the
  reason, and the rest of the result is still applied. A refused level-2
  request is also appended to the findings queue, so the filer can turn it
  into an issue for a reviewed PR.
- AC-9. **Every action is logged.** `actions/log.jsonl` in the state
  directory gets one line per request: `id` (random), `at`, `agent` (the
  agent's name, or `maintainer` for the commands of AC-6, AC-10 and AC-17),
  `run_id`, `kind`, `args`, `why`, `status` (`applied`, `refused`, `failed`,
  `undone`), `reason` for a refusal or failure, `undo` (the inverse action as
  `{ kind, args }`, or `null` when there is none), and `undoes` (the id this
  entry reverses, for an undo). The line for a request is written before the
  effect, with status `pending`, and rewritten after it; a crash in between
  leaves a `pending` line the next start marks `failed`. Given an action
  that changes a parameter, pauses an agent or re-runs a workflow, then the
  entry's `undo` is never null. The log is append-only; nothing in the
  scheduler rewrites or deletes earlier lines except the status rewrite of
  the line in flight.
- AC-10. **Undo is a command and an action.** `panelator-scheduler action
  undo <id>` (and the `undo` action kind) applies the entry's recorded undo,
  logs it as a new entry with `undoes: <id>`, and marks the original
  `undone`. Given an entry already undone, refused or failed, or whose `undo`
  is null, then the command exits non-zero with the reason and nothing is
  logged as applied. `panelator-scheduler action list [--since <time>]`
  prints the log.

**Parameter store** (design section 9, charter)

- AC-11. **Parameters are defined in the repository and stored in state.**
  `agents/parameters.yaml` defines each parameter: `name`, `type` (`number`,
  `boolean`, `string` or `duration`), `default`, `min` and `max` for numbers
  and durations, `mode` (the initial mode, `auto` or `locked`), and a
  one-line description. The store is `parameters.json` in the state
  directory: per parameter `value`, `mode`, `set_by` (`default`,
  `maintainer` or an agent name) and `at`. A parameter missing from the
  store takes its definition's default and initial mode; a parameter in the
  store but no longer defined is kept until the definition returns and is
  not read. Every change is also appended to `parameters/history.jsonl`
  (name, old and new value or mode, actor, time). The initial definitions:
  - `aws_cap_usd`: number, default 0, min 0, `locked` (F1 adds the consumer);
  - `system_work_share`: number in `[0, 1]`, default 0.75, `auto` (AC-14);
  - `slots`: number, min 1, max 4, default the `slots` of
    `agents/scheduler.yaml`, `auto`; the loop reads it each tick;
  - `first_contact_needs_approval`: boolean, default `true`, `locked`;
  - one `schedule.<agent>` per standing agent with a schedule trigger
    (AC-13), created from the registry rather than listed in the file.

  Given a definition with an unknown key, an out-of-range default or a
  duplicate name, then loading fails as in AC-1. (Amended by spec 025 section
  4: `standing.event_debounce` is added.)
- AC-12. **Locks are enforced in code.** Changing a value goes through one
  function, `setParameter(name, value, actor)`, and changing a mode through
  `setParameterMode(name, mode, actor)`. Given `setParameter` for a `locked`
  parameter by any actor other than `maintainer`, then it throws
  `ParameterLockedError`, the store is unchanged, and the calling action is
  refused (AC-9) with that reason. Given `setParameterMode` by any actor
  other than `maintainer`, then it throws and nothing changes: no action
  kind sets a mode. Given a value outside the definition's type or range,
  then it throws and nothing changes. The only `maintainer` actor is the
  command line of AC-17 (and the console, spec E); no agent result, prompt
  or stage definition can name an actor. A test asserts each refusal and
  that no action kind in `agents/actions.yaml` can change a mode.
- AC-13. **Schedules are parameters.** Given a standing agent whose trigger
  has `schedule`, then `schedule.<name>` is a `duration` parameter whose
  default is the definition's interval, min `1h`, max `30d`, initial mode
  `auto`, and the agent's `next_run` is computed from the parameter's
  value, not the file. Given the parameter is locked by the maintainer, then
  a later change to the interval in the agent's file changes the default
  only; the value stays.
- AC-14. **The shortlist ranks by the work share.** An eligible issue is
  classified as `system` or `product` work: `product` when its spec (read on
  `origin/main`, as the gates read it) has a `Parent:` chain ending at
  `docs/product-spec.md`, `system` when it ends at
  `docs/delivery-system-design.md`; an issue with no spec yet is `product`
  when it carries the `class:product` label and `system` otherwise. The
  merge record of spec 001 gains `work` beside `cls`. Given the ranking,
  then a maintainer priority label still comes first; after it, with `s` and
  `p` the system and product merges of the last 14 days and `share` the
  `system_work_share` parameter, the preferred kind is `system` when
  `s < share * (s + p + 1)`, else `product`; the preferred kind ranks before
  the other, and oldest first within each. The feature-to-debt ratio is no
  longer used for ranking; `cls` stays in the record for metrics (spec D).
  Given `share` is `1`, then product issues are worked only when no system
  issue is eligible; given `0`, the reverse. Spec-track merges are still not
  recorded (spec 006 AC-4).

**Findings filer** (process-spec 4.2, 4.4; design section 4 and 11)

- AC-15. **The filer is a standing agent.** `agents/standing/findings-filer.md`:
  strong tier, Claude, `worktree: fresh` (it reads the designs, ADRs, specs
  and code), events `finding_queued` and `issue_abandoned`, schedule `1d`
  (the sweep), actions none, output `filer-result`. Its input carries the
  next unconsumed queue records (at most 20 per run, oldest first, each with
  the queue line number as its `ref`), every open issue labelled `abandoned`
  not re-triaged in the last 7 days (with its abandonment comment, its
  archived ledger and the count of earlier re-triages), and the titles and
  numbers of the open bot-authored issues, so it can see duplicates. Its
  instructions are process-spec 4.2 step 2: investigate independently, ask
  whether the finding is a symptom of something more fundamental, whether it
  is an issue at all, and whether it fits the design; the filer never acts
  on a finding's own claim without checking it.
- AC-16. **Every record gets one decision.** `filer-result` is
  `standing-result` plus `decisions: [{ ref, outcome, reason, ...}]`, one
  per record in the input, with these outcomes:
  - `discard`: `reason` says why it is not an issue;
  - `file`: with `issue: { title, body, class }` where `class` is one of the
    class labels of `agents/scheduler.yaml`; the body carries the finding
    (what, where, evidence, how it was noticed) and what the filer verified;
  - `merge_into`: with `issue_number` of an open bot-authored issue; the
    record is appended to it as a comment;
  - `escalate`: a possible design flaw, with `question` in the shape of spec
    006 AC-8 (kind `product` or `technical`, options with costs, a
    recommendation) and `issue: { title, body, class }` for the issue that
    carries it (AC-21);
  - `security`: a security finding, with `advisory: { title, description,
    severity }` (AC-22).

  Given a decision missing for an input record, or a record not in the
  input, then the result is a failed run and nothing is consumed. Given a
  valid result, then each decision is applied in order and written to
  `findings/triage.jsonl` (the record's ref, the outcome, the reason, the
  issue or advisory created, the run id, the time), and only then does
  `findings/cursor.json` move past the batch. A crash between applying and
  moving the cursor makes the next run see the batch again, and a decision
  already in `triage.jsonl` for a ref is not applied twice. (Amended by spec
  025 section 4: a `discard` may carry `rests_on_pr`, and a result in a recorded
  shape is put right before validation.)
- AC-17. **The maintainer's commands.** `panelator-scheduler param list`
  prints every parameter with its value, mode, `set_by` and time;
  `param set <name> <value>` and `param mode <name> auto|locked` call the
  functions of AC-12 as `maintainer` and are logged in the action log with
  `agent: maintainer`. The commands run on the laptop as the user the
  service runs as; they are the console's stand-in until spec E.
- AC-18. **A filed issue enters the shortlist.** Given a `file` decision,
  then the scheduler creates the issue as the App with the class label and
  `validated`, and a body that ends with a hidden marker
  `<!-- panelator-finding:<run id>:<ref> -->`, used so a crash does not file
  it twice (the scheduler searches open issues for the marker before
  creating). A `web-ui` or `widget` spec is not written by the filer; the
  issue has no `Spec:` line, so the chain starts at the spec stage (spec 006
  AC-19). Given a `merge_into` decision whose issue is closed or not
  bot-authored, then the decision is applied as `file` instead and the
  triage line says so.
- AC-19. **Discards are kept.** A `discard` decision is recorded in
  `triage.jsonl` with its reason and nothing else happens. Given a record
  discarded whose `what` and `where` match a record discarded in the last 30
  days, then the filer's input marks it as a repeat with the earlier reason,
  so it can decide whether the repetition itself is the issue. (Amended by
  spec 025 section 4: a discard resting on a PR that closes unmerged is offered
  again, at most twice.)
- AC-20. **Abandoned issues are re-triaged.** Given an issue labelled
  `abandoned` in the input, then the result carries one decision for it,
  with `ref: "issue:<number>"`, and one of these outcomes:
  - `retry`: the `abandoned` label is removed with a comment giving the
    filer's reason and what the next attempt should do differently; the
    escalation ledger is fresh (spec 006 AC-7), so the chain runs again;
    allowed at most twice per issue, counted in `triage.jsonl`;
  - `rewrite`: a new issue is filed (as `file`) that supersedes it, and the
    old issue is closed with a comment linking the new one;
  - `close`: the issue is closed with the reason (not worth doing, done
    elsewhere, or superseded);
  - `escalate`: as in AC-16, when the repeated failure points at a design
    flaw; the abandoned issue stays as it is until the escalation issue's
    chain ends, then is re-triaged again;
  - `defer`: left as it is with a reason; it is offered again after 7 days.

  Given an issue that has used both retries and is abandoned again, then
  `retry` is refused by the scheduler (the decision is recorded as `defer`
  with that reason) so an issue cannot loop between the chain and the filer
  without a change in between. The maintainer may still remove the label by
  hand, as spec 006 AC-5 says.
- AC-21. **A design flaw goes to the question check through the spec
  stage.** Given an `escalate` decision, then the scheduler files its issue
  (as `file`, AC-18) with a body headed "Possible design flaw" that carries
  the finding, the filer's investigation and the question with its options,
  costs and recommendation, and no `Spec:` line. When the chain claims it,
  it starts at the spec stage in `write` mode (spec 006 AC-19); that stage's
  prompt says that for such an issue it either returns the question (which
  the question check judges, spec 006 AC-12), or, when it finds the flaw
  settles on its own investigation, decides it and records an ADR under
  `docs/decisions/` in its spec PR with the spec that carries the change
  (process-spec 4.2 step 3). A `decide_yourself` from the check comes back
  to the spec stage as today. The filer never sends a question itself and is
  never the asking stage.
- AC-22. **Security findings never reach the public tracker.** Given a
  `security` decision, or a queue record with `security: true` for which the
  filer chose `file`, then no issue is created: the scheduler creates a draft
  repository security advisory through the App (permission "repository
  security advisories: write", spec 001 section 12) with the title,
  description and severity, records its id in `triage.jsonl`, and sends one
  notification naming the advisory. Given the advisory API call fails, then
  the decision is recorded as failed with the error, a notification is sent,
  and the cursor still moves; the record is listed in the next run's input as
  "security, advisory failed" so the filer retries it. A test asserts that no
  issue-creation call is made for a security record.

**Action audit** (design section 6.2)

- AC-23. **The action audit is a standing agent.**
  `agents/standing/action-audit.md`: strong tier, schedule `7d`, `worktree:
  none`, actions none, output `standing-result`. Its input is the action log
  since its last run (and the 30 days before, for context), grouped by kind
  with counts of applied, refused, failed and undone entries, and the
  parameter history. It judges whether any kind of action goes wrong
  repeatedly (undone by the maintainer, failed, or applied with a `why` the
  log shows to be mistaken) and returns a finding per such kind, whose `what`
  starts with `move action kind <kind> to level 2` and whose evidence lists
  the entries. The filer files that as an issue; the issue's PR sets `level:
  2` in `agents/actions.yaml` (a reviewed PR, as the design requires), after
  which the kind is refused (AC-8). Given nothing is wrong, then the result's
  summary says so and carries no findings.
- AC-24. **Level-2 kinds are not quietly dropped.** Given an agent whose
  `actions` list names a kind that is now level 2, then the registry still
  loads (the kind exists), the request is refused at run time with the
  reason "level 2", and the finding of AC-8 is queued, so a reviewed PR can
  change the agent or the kind.

## 4. Design notes (agent's calls)

- **Definition files mirror stage definitions** (design section 6.1 asks
  for this) and are loaded by the same parser, so the registry costs one
  more `kind` and a `trigger` block. The prompt body is the agent, as it is
  for stages.
- **Events are pending-event lists per agent, not a bus.** The scheduler is
  one process with one tick; the durable part is the agent's state file,
  written before the causing action completes. Spec D's event store records
  the same events for metrics; this spec does not wait for it. Design section
  13 leaves this wiring to the builder.
- **Standing agents take ordinary slots**, after resumes and before the
  shortlist, so a reflection or a filer never starves the chain for long and
  never runs beside more work than `slots` allows. The `slots` parameter is
  how the maintainer or the system widens that.
- **The scheduler, not the agent, touches GitHub and the store.** Every
  effect of a standing agent is data in its result that code applies: that
  is what makes "enforced in code" true for locks, levels, labels and
  authority, and it gives the action log one writer.
- **A design flaw becomes an issue for the spec stage** rather than a new
  question path. The chain already has the question check, pause, resume,
  record and decide-yourself machinery keyed on an issue; a filer-sent
  question would need all of that again without an issue to hang it on.
- **Moving a kind to level 2 is a reviewed PR**, by the audit's finding,
  through the filer, through the chain. The audit judges; the change to
  `agents/actions.yaml` is repository content, which the design says goes
  through review.
- **Work share, not a ratio pair.** One number in `[0, 1]` is what the
  console's slider will set (design section 9). The classification walks the
  `Parent:` chain because that is the one fact the design hierarchy makes
  reliable; labels are the fallback for issues that have no spec yet.
- **No store outside the system's reach**, as the design states: the
  parameter store and the action log live in the state directory, and the
  maintainer's trust is in the reviewed PRs that touch this code and in the
  action audit.

## 5. Interfaces and files

- `tools/scheduler/src/standing/`:
  - `registry.ts`: loads `agents/standing/*.md` (AC-1), the registry test's
    checks, placeholders;
  - `state.ts`: the per-agent state file (AC-3, AC-6), pruning (AC-2);
  - `events.ts`: the event names, `emit(event, payload)` appending to
    subscribers' pending events (AC-4), the `main` check-run watcher;
  - `run.ts`: running a due agent through the runner, applying
    `standing-result` (AC-5), retry and failure handling (AC-3).
- `tools/scheduler/src/actions/`: `index.ts` (the kinds table, `apply`,
  `refuse`, the checks of AC-8), one file per kind, `log.ts` (AC-9), `undo.ts`
  (AC-10).
- `tools/scheduler/src/parameters/`: `definitions.ts` (`agents/parameters.yaml`
  and the schedule parameters, AC-11, AC-13), `store.ts` (`setParameter`,
  `setParameterMode`, `ParameterLockedError`, history, AC-12).
- `tools/scheduler/src/filer/`: `input.ts` (queue cursor, batch, abandoned
  issues, repeats, AC-15, AC-19), `apply.ts` (decisions, issues with the
  marker, merge-into comments, re-triage, advisories, `triage.jsonl`, AC-16,
  AC-18, AC-20 to AC-22).
- `tools/scheduler/src/shortlist/rank.ts` and `src/state/merges.ts`: the work
  classification and the share ranking (AC-14); `src/shortlist/fetch.ts`
  reads the parent chain on `origin/main`.
- `tools/scheduler/src/service/loop.ts`: the standing-agent step of a tick
  (AC-3), `slots` from the store, the event emits at merge, abandonment,
  queue append and resume (AC-4), the `ci_failure_main` watcher.
- `tools/scheduler/src/chain/driver.ts`: emits `merge`, `issue_abandoned`
  and `maintainer_reply`; `src/state/findings.ts`: emits `finding_queued`.
- `tools/scheduler/src/state/paths.ts`: `agents/`, `actions/log.jsonl`,
  `parameters.json`, `parameters/history.jsonl`, `findings/cursor.json`,
  `findings/triage.jsonl`, `main-checks.json`.
- `tools/scheduler/src/stages/definition.ts` and `src/types.ts`: `kind:
  standing`, `trigger`, `worktree: none`, `actions`; the usage record's
  `stage` accepts standing agent names.
- `tools/scheduler/src/github/client.ts`: create an issue with labels, list
  open issues by label and by author (full pagination, process-spec 6.4),
  search open issues for a body marker, close an issue with a comment, remove
  a label, list check runs for a SHA, re-run and cancel a workflow run,
  create a draft repository security advisory.
- `tools/scheduler/bin/scheduler.ts`: the `agent`, `action` and `param`
  commands (AC-6, AC-10, AC-17).
- `agents/standing/findings-filer.md` and `agents/standing/action-audit.md`
  (AC-15, AC-23); `agents/actions.yaml` (AC-8); `agents/parameters.yaml`
  (AC-11).
- `agents/stages/spec.md`: the "Possible design flaw" paragraph of AC-21.
- `schemas/scheduler/`: `standing-definition.json`, `standing-result.json`,
  `action.json`, `action-log-entry.json`, `parameter-definition.json`,
  `parameters.json`, `filer-result.json`, `triage-entry.json`,
  `agent-state.json`; `usage-record.json`'s `stage` widened.
- `tools/scheduler/test/`: `standing.test.ts` (registry, state, events,
  scheduling, pause), `actions.test.ts` (kinds, log, refusals, undo),
  `parameters.test.ts` (store, locks, modes, ranges, schedule parameters),
  `filer.test.ts` (batches, cursor, every outcome, re-triage bounds,
  advisories), `shortlist.test.ts` (AC-14), the registry test over the real
  `agents/standing/`, and the recorded chains of section 6 in `e2e.test.ts`.
- `tools/README.md`: the three commands and the `agents/standing/` layout
  (documentation of the tool, in its own package).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed except `tools/README.md`, listed above.
`tools/scheduler/` and `agents/` are sensitive paths,
so the security review runs on the PR as spec 006 AC-9 says. Nothing here
changes the sensitive-path list, the security criteria, or what routes a
sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the registry test over `agents/standing/` and `agents/actions.yaml`
    (AC-1, AC-8);
  - the lock refusals and the mode rule (AC-12);
  - the shortlist ranking table for shares 0, 0.5, 0.75 and 1 (AC-14);
  - recorded end-to-end runs (fake adapter, mocked GitHub) for: a schedule
    run that sets a parameter, then its undo by the command; a locked
    parameter refused and logged; a merge event waking the filer, which
    files one issue, discards one record, merges one into an open issue and
    creates one draft advisory; an abandoned issue retried, abandoned again,
    retried again, and then deferred; an escalation issue whose chain starts
    at the spec stage and reaches the question check; a level-2 request
    refused and queued; an agent paused by the maintainer that the system
    cannot resume; the spec 006 AC-28 and spec 007 chains unchanged.
- After the service is restarted on the merged code, the first real filer
  run and the first real direct action are written up in `dev-logs/` with
  their run records, the triage lines and the action log entries.

## 7. Open decisions

None.
