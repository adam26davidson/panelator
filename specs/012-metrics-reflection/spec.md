# 012. Event store, metrics and reflection agents

Status: written 2026-10-28 from the delivery-system design (spec D); specs
derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 3 ("Recording"), 6.1 (the three reflection rows), 6.2, 7, 11 (row D)
and 13; [charter](../../docs/charter.md) (metrics, self-improvement,
meta-improvement, reflection with an actionable plan, expanding what is
automated); [design-tree](../../docs/design-tree.md) R6.Q12, R7.Q2;
[ADR 0002](../../docs/decisions/0002-event-store-jsonl-with-sqlite-query-index.md)
(the store); [process-spec](../../docs/process-spec.md) sections 4.2 and 7
(superseded by design section 7); builds on
[008-agent-registry](../008-agent-registry/spec.md) (standing agents, results
applied in code, issues filed as the App) and amends its AC-1 and AC-3 with
the `min_events` trigger field (AC-14 below).

What the maintainer decided (design sections 6.1 and 7, and the issue), kept
as it is here: everything is recorded raw and metrics are derived as queries;
reflection and meta-reflection choose and change metrics over time; a metric
change is a reviewed design change, and a replaced metric keeps running beside
the new one for a few weeks; each reflection produces an actionable plan filed
as App-authored `validated` issues; charter reflection also reviews every
maintainer contact in the period and files issues to automate recurring ones.

## 1. Goal

Give the delivery system its memory and its mirror:

- **An event store.** Every run, stage transition, merge, CI result, review,
  finding, direct action, question and answer, wait in the queue and
  shortlist, pause on the maintainer, slot occupancy sample, notification,
  parameter change and standing-agent run is appended as a raw event to the
  scheduler's own store and never discarded (ADR 0002). What exists from
  before this spec is backfilled.
- **Metrics as queries.** A metric is a definition file in the repository
  holding a SQL query over the events, with the charter goal it tracks and
  the reasoning for it. The scheduler computes every active metric, and every
  replaced metric still inside its overlap window, on demand and for each
  reflection run. The design's seed set ships as the first five definitions.
- **Three reflection agents** on spec 008's registry. Delivery reflection
  (weekly, or after a batch of merges) looks for bottlenecks and metric
  trends. Charter reflection (weekly) judges the system against each charter
  clause and reviews every maintainer contact. Meta-reflection (monthly)
  judges whether the metrics and the reflections themselves are working. Each
  returns a plan; the scheduler posts the plan as a record and files its
  items as App-authored `validated` issues, which the shortlist then works.

## 2. Out of scope

- The console (spec E). Its History screen shows the metrics this spec
  computes, old and new side by side; its Agents screen shows the three
  agents. Until E lands, `panelator-scheduler metrics` on the laptop is the
  maintainer's view (AC-10). The metrics report (AC-9) is the data contract
  E consumes; no screen is designed here.
- AWS cost records (spec F1). The event kind `aws.cost` is a reserved name
  with no producer; the spend metric uses token cost only until F1 records
  it.
- Funds, credential and first-contact requests (spec F2). They are maintainer
  contacts and will be recorded as `maintainer.contact` events by F2 using
  the function this spec provides; here the contacts recorded are questions,
  reminders and notifications.
- Telegram delivery of plans or summaries (spec A's channel carries
  questions; a plan is a GitHub record, AC-16). Nothing is sent to the
  maintainer for a plan.
- Changing any metric's definition after it ships, adding a metric beyond the
  seed set, or retiring one: each is a reviewed PR that a reflection files as
  an issue (AC-19); this spec builds the mechanism, not the second metric.
- Changing the issue chain, its stages, bounds or transitions, the findings
  filer, the action audit or the parameter store, beyond the `min_events`
  trigger field (AC-14) and the recording calls (AC-2).
- Intake, grilling and the authority rule: unchanged. A reflection never
  posts to GitHub itself; the scheduler files from its result, as spec 008
  AC-5 requires.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
The reflection agents run through spec 008's registry, runner, bounds, retry
and failure handling (spec 008 AC-3), and their results are applied by the
scheduler (spec 008 AC-5).

**Event store** (design section 7, ADR 0002)

- AC-1. **One writer, one envelope, never rewritten.** `recordEvent(paths,
  event)` in `tools/scheduler/src/events/store.ts` is the only code that
  writes `events/<YYYY-MM>.jsonl` in the state directory (the month of `at`).
  An event is `{ id, at, kind, issue?, run_id?, agent?, payload }`: `id` a
  random string, `at` an ISO time, `kind` one of the names in AC-2, `issue`
  the issue number when the event belongs to one, `run_id` and `agent` when
  it belongs to a run or a standing agent, and `payload` the raw record as
  the scheduler had it, validated against `schemas/scheduler/event.json`
  (which fixes the envelope and names, per kind, the payload schema or
  `true`). Given a `recordEvent` call, then one line is appended before the
  caller continues; given a kind not in AC-2 or a payload that fails its
  schema, then the call throws and nothing is written. Nothing in the
  scheduler rewrites, truncates, moves or deletes a file under `events/`; a
  test greps the source for every open of `events/` and asserts each is an
  append or a read. The usage pruning of spec 001 section 11 is unchanged
  and no longer loses data (the event has the copy).
- AC-2. **Every point the design names is recorded.** The scheduler records,
  at the moment it writes the existing record or makes the transition, with
  the payload shown:
  - `run.ended`: the usage record of spec 001 AC-24 (chain stages, rescues,
    question checks and standing agents alike), with `issue`, `run_id` and,
    for a standing agent, `agent`;
  - `chain.transition`: `{ from, to, event, attempt, fixes, track, rescue }`
    on every change of `ChainState.stage`, so stage durations, attempts and
    fix cycles per issue are derivable;
  - `issue.eligible`: `{ rank, work, cls, validated_at, created_at }`
    (`validated_at` the time of the issue's `validated` labelling read from its
    label events, or `null` when none; `created_at` the issue's creation time)
    the first tick an issue is in the
    eligible shortlist and not claimed (recorded once per issue per period of
    eligibility; a later claim closes the wait), `issue.claimed`: `{ slot }`,
    and `issue.released`: `{ reason }` (`done`, `abandoned`, `postponed`,
    `paused`, `error`, `stopped`), which together give queue and shortlist
    wait time;
  - `merge`: the merge record of spec 001 (`issue`, `pr`, `cls`, `work`,
    `at`), and `pr.opened`: `{ pr, track }`;
  - `ci.check`: `{ sha, pr?, check, status, run_id }` whenever the scheduler
    reads a check run's final state for a PR head or for `main` (spec 008's
    `main` watcher), once per `(sha, check, status)`;
  - `review.result`: `{ pr, head_sha, verdict, findings, criteria_failed,
    independent, reviewer_model, security }` for every review and security
    review result;
  - `finding.queued`: the queue envelope and the finding; `finding.triaged`:
    the triage entry of spec 008 AC-16;
  - `action`: the action log entry of spec 008 AC-9, on each status rewrite
    (so `pending`, `applied`, `refused`, `failed` and `undone` each appear);
  - `question`: the question log entry of spec 006 AC-18, for each of its
    events (`asked`, `checked`, `sent`, `reminded`, `answered`), with the
    question comment id when present;
  - `pause.started` and `pause.ended`: `{ stage, question_comment_id?,
    reason }` when a paused record is written and when the issue resumes,
    giving time paused on the maintainer;
  - `slots.sample`: `{ active, slots, chains, standing }` once per tick, and
    on each change within a tick, giving slot occupancy over time;
  - `maintainer.contact`: `{ channel, kind, issue?, question_comment_id?,
    label, text }` for every notification the notifier sends (`kind:
    notification`, `channel: log` or `telegram`), every question sent
    (`kind: question`) and every reminder (`kind: reminder`); F2 adds
    `funds`, `credential` and `first_contact`;
  - `parameter.changed`: the history entry of spec 008 AC-11;
  - `agent.run`: `{ outcome, summary, events_received, actions, findings }`
    when a standing agent's run ends;
  - `issue.filed`: `{ number, by, class, labels, marker }` for every issue the
    scheduler creates (the filer, a reflection, spec 006's escalation issues);
  - `reflection.plan`: the plan of AC-16 with its plan issue number;
  - `metrics.snapshot`: the report of AC-9 as computed for a reflection run or
    the `metrics --snapshot` command.

  `aws.cost` is a valid name with no producer (section 2). Given the recorded
  chains of spec 006 AC-28, spec 007 and spec 008 section 6 run with
  recording on, then every kind above except `aws.cost` and the F2 contact
  kinds appears at least once across them, asserted by a test over the
  resulting `events/` files; and the chains' own assertions still pass
  unchanged.
- AC-3. **The index is derived and rebuildable.** `events/index.sqlite` is a
  `node:sqlite` database with one table `events(id TEXT PRIMARY KEY, at TEXT,
  kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT)` with
  indexes on `(kind, at)` and `(issue)`, and a `meta` table holding the
  schema version and, per monthly file, the byte offset read so far.
  `openIndex(paths)` loads every line not yet loaded, then returns the
  database. Given the file is missing, fails to open, or carries an older
  schema version, then it is deleted and rebuilt from the JSONL in full.
  Given a line that fails to parse, then it is skipped, counted, and reported
  in the service log once per file; the raw file is not touched. Given the
  index is deleted while the service runs, then the next `openIndex` rebuilds
  it and every metric gives the same values as before, asserted by a test.
- AC-4. **History is backfilled once.** `panelator-scheduler events backfill`
  reads the records that exist before this spec, `usage/*.json`,
  `merges.jsonl`, `actions/log.jsonl`, `questions/log.jsonl`,
  `findings/queue.jsonl`, `findings/triage.jsonl` and `parameters/history.jsonl`,
  and records each as the matching kind of AC-2 with the record's own time as
  `at` and `payload.backfilled: true`; the service also runs it at the first
  start after this code lands (a marker `events/backfilled.json` holds the
  time and counts). Given it is run twice, then no event is recorded twice
  (the backfill id is derived from the source record, so the second run finds
  every id present). Given a record that fails its payload schema (an old
  shape), then it is recorded with the envelope's `payload` as it is and the
  count of such records is printed, rather than dropped.

**Metrics** (design section 7)

- AC-5. **A metric is a definition file.** `agents/metrics/<name>.yaml` has:
  `name` (equal to the file name), `goal` (one of `speed`, `delivery`,
  `quality`, `spend`, `autonomy`, the charter's five), `description` (one
  line), `unit`, `direction` (`lower` or `higher` is better), `introduced`
  (a date), `rationale` (the design write-up: what decision the metric
  drives and why it tracks the goal, at least 200 characters), `query` (SQL
  over the `events` table of AC-3, returning rows `(bucket, value, n)` for
  weekly buckets when run with the parameters `:from` and `:to`), and
  optionally `replaces` (the name of the metric it supersedes) and
  `retired` (a date after which it is no longer computed). Given a file with
  an unknown key, a missing required key, a `goal` not in the list, a query
  that fails to prepare against an empty index, or a query that does not
  return the three columns, then loading fails naming the file and the key,
  the service exits 78 as for a bad config, and the same check fails the
  vitest registry test over the repository's `agents/metrics/`. The query
  may read the table of AC-3 only: a query naming another table, or any
  statement other than one `SELECT` (or `WITH ... SELECT`), is rejected by
  the loader, and the index is opened read-only for metrics.
- AC-6. **The seed set ships.** The repository carries these five
  definitions, each with its rationale, computed per ISO week:
  - `issue_to_merge_days` (speed, lower): median days from the issue's
    `validated` labelling (`validated_at` of its first `issue.eligible` payload,
    or that payload's `created_at` when `validated_at` is `null`) to its
    `merge` event, for issues
    merged in the bucket;
  - `merged_per_week` (delivery, higher): count of `merge` events in the
    bucket, with `n` the count and `value` the count, and companion rows
    split by `work` (`system` and `product`) as separate metric definitions
    `merged_per_week_system` and `merged_per_week_product`, counted as one
    seed metric in this list;
  - `rework_per_merge` (quality, lower): mean fix cycles plus rescues per
    merged issue in the bucket (`chain.transition` events into `fix` and
    with `rescue: true`), and `post_merge_defects` (quality, lower): count
    of `issue.filed` events with class `class:bug` in the bucket whose body
    cites a PR merged in the previous 30 days (the filer's body carries the
    finding's `where`); both are seed metrics under "rework and post-merge
    defects";
  - `cost_per_merged_issue_usd` (spend, lower): the sum of `run.ended`
    `cost_usd` over every run with the issue's number, divided by the merges
    in the bucket, for issues merged in the bucket;
  - `questions_per_week` (autonomy, lower): count of `question` events with
    event `sent` in the bucket, with a companion `questions_decide_yourself`
    counting `checked` events whose verdict is `decide_yourself`, since the
    design uses that to tune the threshold.

  Given the fixture event set in `tools/scheduler/test/fixtures/events/`
  (hand-written events covering every kind of AC-2 across six weeks), then
  each seed metric returns the values listed in the fixture's
  `expected.json`, asserted by a test.
- AC-7. **A replaced metric runs beside its replacement.** Given a
  definition with `replaces: <old>`, then the metric `<old>` must still exist
  and be computed until 28 days after the new definition's `introduced` date:
  the registry test fails when `<old>` is missing and today is inside that
  window, and the metrics report (AC-9) carries both, marking the old one
  `replaced_by: <new>` and the days left. Given the window has passed, then
  the old file may be removed or given `retired` in a reviewed PR, and until
  it is, it keeps being computed. A metric with `retired` in the past is
  loaded (so history can still be queried with `metrics show <name>`) and
  left out of the report by default.
- AC-8. **A metric change is a reviewed change with a write-up.** Adding,
  changing or removing a file under `agents/metrics/` is repository content
  under `agents/`, so it goes through a reviewed PR (design section 6.2,
  level 2) and the security review as every `agents/` change does (spec 006
  AC-9); nothing in this spec changes which paths are sensitive or what
  routes them. The `rationale` field is the design write-up the design asks
  for: given a changed or new definition whose `rationale` is unchanged from
  the metric it `replaces`, or shorter than 200 characters, then the registry
  test fails, so a PR cannot swap a query without saying why. A reflection
  proposes a metric change only as an issue (AC-19); no action kind writes
  under `agents/`.
- AC-9. **The report.** `computeMetrics(index, definitions, { from, to })`
  returns `metrics-report`: `{ from, to, computed_at, metrics: [{ name,
  goal, unit, direction, introduced, status: active | replaced | retired,
  replaced_by?, overlap_days_left?, buckets: [{ bucket, value, n }] }] }`,
  for every definition not retired (and retired ones on request), over
  weekly buckets from `from` to `to`. Given a bucket with no events, then it
  appears with `value: null` and `n: 0`, so a gap is visible rather than
  skipped. The report is what the reflection inputs carry (AC-15) and what
  the `metrics` command prints, and each computation for a reflection run or
  with `--snapshot` is recorded as a `metrics.snapshot` event, so the History
  screen (spec E) and meta-reflection can see what a reflection saw at the
  time.
- AC-10. **The maintainer's view until the console.** `panelator-scheduler
  metrics [--weeks <n>] [--json] [--snapshot] [--all]` prints the report for
  the last `n` weeks (default 12) as a table, one row per metric and bucket,
  or as JSON; `--all` includes retired metrics; `metrics show <name>` prints
  one metric's definition and its full history. `panelator-scheduler events
  query "<sql>"` runs one read-only `SELECT` against the index and prints the
  rows, for the maintainer and for a dev-log. The commands run on the laptop
  as the service user and read the state directory; they never write the
  JSONL.

**Reflection agents** (design section 6.1, charter)

- AC-11. **Delivery reflection is a standing agent.**
  `agents/standing/delivery-reflection.md`: strong tier, Claude, `worktree:
  fresh` (it reads the charter, the designs, the specs, the metric
  definitions and the code), `trigger: { schedule: 7d, events: [merge],
  min_events: 10 }` (AC-14), bounds `timeout_min: 45`, `max_turns: 80`,
  `max_cost_usd: 8`, actions `set_parameter`, `pause_agent`, `resume_agent`,
  `run_agent`, input `reflection-input`, output `reflection-result`. Its
  prompt asks for the charter's bottleneck question: where does time go
  between a validated issue and a merge, which stages fail or loop, what the
  metric trends say about speed, delivery, quality, spend and autonomy, and
  what change would remove the largest bottleneck without lowering the bar;
  each finding becomes a plan item (AC-16). It also walks the design tree
  (design section 10, staleness) from the input's `design_tree` (AC-15): for
  every `docs/designs/<slug>.md` child path that has no file, and every merged
  spec whose issue has no merged implementation PR, it files one plan item
  (a finding, never an automatic rewrite), or states why not.
- AC-12. **Charter reflection is a standing agent.**
  `agents/standing/charter-reflection.md`: as AC-11 with `trigger: {
  schedule: 7d }` and the same actions. Its prompt walks the charter clause
  by clause (the input carries the charter's text split into clauses) and
  asks, for each: is the system meeting it, what evidence says so, and what
  change or new agent would meet it better; whether the console (absent
  until spec E, and the input says so) gives the maintainer the visibility
  and control the charter asks for; and, over the input's list of every
  maintainer contact in the period (AC-15), which kinds recur, filing one
  plan item per recurring kind to automate it (the charter's "expand the
  scope of what can be automated"). Given two or more contacts of the same
  `kind` and `label` in the period, then the input marks them as a recurring
  kind and the result must carry a plan item for it or a stated reason not
  to.
- AC-13. **Meta-reflection is a standing agent.**
  `agents/standing/meta-reflection.md`: as AC-11 with `trigger: { schedule:
  30d }`, actions none, and the extra input of AC-15. Its prompt asks whether
  each metric still tracks the charter goal it names (and whether a metric
  moved because the system improved or because the system learned the
  metric), whether the seed set misses a goal, whether the reflections'
  plans led to merged changes that moved the metrics, and whether the data the
  reflections decide on is adequate; a metric change it wants is a plan item
  with the write-up (AC-19), and a change to a reflection agent's prompt or
  cadence is a plan item too.
- AC-14. **An agent can wait for a batch of events.** Spec 008's `trigger`
  gains an optional `min_events` (an integer, at least 1, default 1), valid
  only with `events`. Given an agent whose trigger has `min_events: N`, then
  it is due on events only when its `pending_events` holds at least `N`
  events; a due schedule still runs it with whatever is pending, and a run
  clears what it received as spec 008 AC-3 says. The registry test of spec
  008 AC-1 accepts the key and rejects `min_events` under 1 or without
  `events`. The filer and the audit keep the default and are unchanged.
- AC-15. **The scheduler builds the input.** `reflection-input` is built by
  `tools/scheduler/src/reflection/input.ts` for the period from the agent's
  last successful run (or 28 days back on the first run) to now:
  - `period`, `agent`, `parameters` (the store), `agents` (every standing
    agent with its last run, next run, paused state and consecutive
    failures);
  - `metrics`: the report of AC-9 for the period plus the previous 12 weeks,
    with each metric's `goal`, `description` and `rationale`;
  - `events_summary`: counts of events by kind and by week;
  - `issues`: for every issue with a `merge`, `issue.released` with reason
    `abandoned`, or `pause.started` event in the period, its timeline from
    the events: eligible, claimed and released times, each `chain.transition`
    with times, every `run.ended` with model, outcome and cost, its reviews,
    its questions and pauses, and its total cost;
  - `open_questions`: every `question` sent and not answered, with the issue,
    the asking stage, the question text and the time sent (design section 3:
    listed in each reflection plan);
  - `previous_plans`: the last plan of each reflection agent (AC-16) with,
    for each issue it filed, the issue's current state (`open`, `in
    progress`, `merged` with the PR, `closed` without a merge, `abandoned`)
    from GitHub and the events;
  - `open_bot_issues`: the number, title, labels and age of every open
    bot-authored issue, so a reflection points at an existing issue rather
    than filing a duplicate;
  - `findings_pending`: the count of queue records the filer has not
    consumed, and the triage outcomes of the period by outcome;
  - for delivery reflection: `design_tree`, built by the scheduler from the
    repository at the period's end: per design, its `## Children` paths each
    with `exists`, and per spec under `specs/` its status line and whether
    the events hold a `merge` for its issue (`implemented`);
  - for charter reflection: `charter` (the clauses of `docs/charter.md`, one
    per paragraph, numbered) and `maintainer_contacts` (every
    `maintainer.contact` event of the period grouped by `kind` and `label`,
    each group with its count, its first and last time and up to three
    example texts, and `recurring: true` when the count is two or more);
  - for meta-reflection: `metric_definitions` (every file under
    `agents/metrics/` in full, including retired), `snapshots` (every
    `metrics.snapshot` of the last 6 months), `all_plans` (every plan of
    the last 6 months with the fate of each filed issue), and
    `question_outcomes` (per month: sent, answered, decide-yourself returns,
    median hours to answer).

  The input is validated against `schemas/scheduler/reflection-input.json`
  before the run, as spec 008 does; a failure is a failed run. The agent
  also reads the repository in its fresh worktree with read-only tools; it
  has no GitHub tool.
- AC-16. **A result is a plan, and the plan is a record.**
  `reflection-result` is `standing-result` plus `plan: { title, summary,
  observations: [{ what, evidence }], items: [{ title, body, class, kind,
  existing_issue? }], metrics_note, open_questions_note, deferred: [{ title,
  why }] }` where `kind` is `bottleneck`, `charter`, `automate_contact`,
  `metric_change`, `agent_change` or `other`, `class` is one of the class
  labels of `agents/scheduler.yaml`, and `body` states what to change, why
  (citing the evidence), and how to tell it worked (which metric or event
  should move). Given a valid result, then the scheduler, in
  `tools/scheduler/src/reflection/apply.ts`:
  1. writes the plan to `reflections/<agent>/<run id>.json` in the state
     directory;
  2. creates one plan issue as the App, titled `<Agent> plan <date>`,
     labelled `reflection` and the agent's name (`reflection:delivery`,
     `reflection:charter`, `reflection:meta`), never `validated`, whose body
     carries the summary, the observations, the metrics note, the open
     questions (each by issue and question), the items with links to the
     issues filed, the direct actions applied in this run (design 6.1), and
     the deferred items; it ends with the marker
     `<!-- panelator-reflection:<run id>:plan -->`;
  3. files each item without `existing_issue` as an issue (AC-17), and for an
     item with `existing_issue` appends a comment to that issue linking the
     plan;
  4. closes the previous plan issue of the same agent with a comment linking
     the new one, so one plan per agent is open at a time;
  5. records `reflection.plan` and applies the result's `actions` and
     `findings` as spec 008 AC-5 does.

  Given a result with no items, then the plan issue is still created and
  says so. Given a crash after step 2, then the next run finds the plan
  marker on GitHub and does not create a second plan issue for that run id;
  the item markers of AC-17 do the same for items.
- AC-17. **Plan items are validated issues the shortlist works.** Given an
  item, then the scheduler creates the issue as the App with the item's
  class label and `validated`, a body that opens with `Plan: #<plan issue>`
  and the item's `kind`, carries the item's body, and ends with the hidden
  marker `<!-- panelator-reflection:<run id>:<index> -->`, searched for
  before creating as spec 008 AC-18 does. The issue has no `Spec:` line, so
  the chain starts at the spec stage (spec 006 AC-19), and the authority
  rule holds because the App is the author. Given more than 8 items without
  `existing_issue`, then the first 8 in the result's order are filed and the
  rest are written into the plan as deferred with the reason "over the plan
  bound", so a reflection cannot flood the shortlist; the bound is chain
  configuration (`agents/scheduler.yaml`, `reflection_max_issues`), not a
  prompt. Given an item whose `class` is not a class label, or whose body is
  under 200 characters, then the item is deferred with that reason and the
  rest of the result is still applied.
- AC-18. **Reflection never acts above level 1.** Given a reflection result
  whose `actions` carry a kind not in the agent's `actions` list, or level
  2, then it is refused and queued as spec 008 AC-8 says. Given a result
  whose plan item asks for a change to `docs/charter.md`, then the item is
  still filed (the chain's spec stage will return it as a question or the
  review will reject it; design section 5), and the plan issue marks it
  "charter change: needs the maintainer". No reflection result changes a
  metric, an agent definition, a parameter's mode or any repository file
  directly: a test asserts that `reflection/apply.ts` writes only under the
  state directory and calls only the GitHub operations named here.
- AC-19. **A metric change is proposed, not made.** Given a plan item with
  `kind: metric_change`, then its body must carry a `## Rationale` section
  (the design write-up) and name the metric it replaces or adds; the filed
  issue carries it, and the spec stage that works the issue writes the
  definition file (AC-5) and, when it replaces a metric, sets `replaces` so
  the overlap of AC-7 applies. Given a `metric_change` item without a
  rationale section, then it is deferred with that reason.
- AC-20. **A reflection that fails is not silent.** Given a reflection run
  that fails twice (spec 008 AC-3), then the finding and notification spec
  008 writes name the agent, and the next scheduled run uses the same period
  start (the last successful run), so no period is skipped. Given a plan
  whose filed issue is later abandoned (spec 006 AC-5), then the next plan's
  `previous_plans` input shows it as `abandoned`, so the reflection sees the
  outcome of what it asked for.

## 4. Design notes (agent's calls)

- **The record is JSONL, the index is SQLite, the metric is SQL** (ADR 0002).
  The maintainer's "record everything raw and derive metrics as queries" is
  taken literally: the raw line is what was written at the time, the index
  is disposable, the metric is a declarative query a reviewer can read
  against the charter. `node:sqlite` is in Node 26, so nothing is installed.
- **Existing records stay; the event store copies them.** Spec 008's action
  log, the question log and the usage records each have one writer and
  consumers that read them; rerouting them through the event store would
  touch every consumer for no gain. Recording beside the existing write is
  one call, and the backfill means history starts before this spec.
- **Metrics live under `agents/`** because that directory is already the
  system's configuration of itself, already sensitive (spec 006 AC-9), and
  already loaded with a registry test at start and in CI; a metric change
  therefore gets the review the design requires without adding a path or a
  rule.
- **The overlap is enforced by a test, not by the scheduler.** "A few weeks"
  becomes 28 days, and the registry test is what stops a PR removing the old
  metric early; the report marking the old metric `replaced_by` is what makes
  the side-by-side visible (and what the History screen will show).
- **A plan is a GitHub issue that is never worked.** The design says plan
  items come out as issues linked to the plan, so the plan needs a stable
  thing to link to that the maintainer can read from a phone today; an
  issue labelled `reflection` and not `validated` is that, costs no new
  storage, and the shortlist ignores it (the validated gate). The state
  directory keeps the JSON for the inputs of later reflections.
- **Eight issues per plan.** Reflection is weekly; eight per agent per week
  is more than the chain merges. A bound in configuration, with the overflow
  written into the plan, is what keeps a verbose model from drowning the
  shortlist while losing nothing it said.
- **`min_events` rather than a new event.** "After N merges" is a property of
  the trigger, and spec 008's pending-events list already holds the merges;
  a counter in the definition is one field and no new producer.
- **The reflection's reach is spec 008's level 1.** The design lists what a
  plan may apply directly (6.1: level 1 changes, listed in the plan); the
  agents get the parameter and agent-pause kinds and nothing that writes the
  repository. Everything else is an issue, so the chain's review is the gate
  on the system changing itself, as the design wants.
- **Charter changes are filed, not swallowed.** A reflection may well
  conclude the charter should change; the design's path for that is a
  question to the maintainer (section 5), and the chain's spec stage and
  question check are already the way a question is raised. Filing the item
  and marking it keeps the trail honest without giving the reflection a new
  channel.

## 5. Interfaces and files

- `tools/scheduler/src/events/`: `store.ts` (`recordEvent`, the envelope,
  the kind table and payload schema map, AC-1, AC-2), `index.ts`
  (`openIndex`, incremental load, rebuild, schema version, AC-3),
  `backfill.ts` (AC-4), `kinds.ts` (the names of AC-2 as a `const` array
  shared with the schema).
- `tools/scheduler/src/metrics/`: `definitions.ts` (loads
  `agents/metrics/*.yaml`, the checks of AC-5, AC-7 and AC-8, the read-only
  `SELECT` rule), `compute.ts` (`computeMetrics`, weekly buckets, the
  report, snapshots, AC-9), `format.ts` (the table for AC-10).
- `tools/scheduler/src/reflection/`: `input.ts` (AC-15, including the
  charter clauses, the maintainer-contact grouping, the issue timelines and
  the previous plans), `apply.ts` (AC-16 to AC-19: the plan file, the plan
  issue, the item issues with markers, the bound, the predecessor close).
- Recording calls (AC-2) in: `tools/scheduler/src/chain/driver.ts`
  (`chain.transition`, `pr.opened`, `merge`, `review.result`, `ci.check`
  for PR heads, `issue.filed` for escalation issues), `src/service/loop.ts`
  (`issue.eligible`, `issue.claimed`, `issue.released`, `slots.sample`,
  `pause.started`, `pause.ended`, the first-start backfill), `src/runner/run.ts`
  or `src/state/runs.ts` (`run.ended`), `src/state/findings.ts`
  (`finding.queued`), `src/filer/apply.ts` (`finding.triaged`,
  `issue.filed`), `src/actions/log.ts` (`action`), `src/state/questions.ts`
  (`question`, and `maintainer.contact` for `sent` and `reminded`),
  `src/notify/log.ts` and the Telegram notifier of spec 007
  (`maintainer.contact` for notifications), `src/parameters/store.ts`
  (`parameter.changed`), `src/standing/run.ts` (`agent.run`, the reflection
  input and apply dispatch), `src/standing/events.ts` (`ci.check` for
  `main`).
- `tools/scheduler/src/standing/registry.ts`, `src/standing/state.ts` and
  `src/types.ts`: the `min_events` trigger field and the due rule (AC-14).
- `tools/scheduler/src/state/paths.ts`: `events/`, `events/index.sqlite`,
  `events/backfilled.json`, `reflections/`.
- `tools/scheduler/src/github/client.ts`: create an issue with labels (as
  spec 008), add a comment, close an issue with a comment, search open
  issues for a body marker, list issues by label (for the previous plan
  issue), get an issue's state and linked PR (for `previous_plans`); all
  with full pagination (process-spec 6.4).
- `tools/scheduler/bin/scheduler.ts`: the `metrics`, `metrics show`,
  `events backfill` and `events query` commands (AC-4, AC-10).
- `agents/standing/delivery-reflection.md`,
  `agents/standing/charter-reflection.md`,
  `agents/standing/meta-reflection.md` (AC-11 to AC-13).
- `agents/metrics/issue_to_merge_days.yaml`, `merged_per_week.yaml`,
  `merged_per_week_system.yaml`, `merged_per_week_product.yaml`,
  `rework_per_merge.yaml`, `post_merge_defects.yaml`,
  `cost_per_merged_issue_usd.yaml`, `questions_per_week.yaml`,
  `questions_decide_yourself.yaml` (AC-6).
- `agents/scheduler.yaml`: `reflection_max_issues: 8` (AC-17); the labels
  `reflection`, `reflection:delivery`, `reflection:charter`,
  `reflection:meta` are created by the scheduler if missing, as the claim
  label is.
- `schemas/scheduler/`: `event.json` (the envelope and per-kind payload
  references), `metric-definition.json`, `metrics-report.json`,
  `reflection-input.json`, `reflection-result.json`, `reflection-plan.json`;
  `standing-definition.json` gains `trigger.min_events`.
- `tools/scheduler/test/`: `events.test.ts` (envelope, append-only grep,
  every kind recorded across the recorded chains, index rebuild equality,
  backfill idempotence), `metrics.test.ts` (definition checks, the read-only
  rule, seed values against the fixture, the overlap window, the rationale
  rule, the report's null buckets), `reflection.test.ts` (input building
  from the fixture events, recurring contacts, plan issue and item markers,
  the bound and deferrals, predecessor close, charter-change marking, the
  write-only-under-state assertion, metric-change rationale), the registry
  tests over `agents/standing/` and `agents/metrics/`, `min_events` in
  `standing.test.ts`, and the recorded runs of section 6 in `e2e.test.ts`;
  `test/fixtures/events/` with its `expected.json`.
- `tools/README.md`: the four commands, the `agents/metrics/` layout, the
  three agents and what a plan issue is (documentation of the tool, in its
  own package).

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
`dev-logs/` is changed by the implementation. `tools/scheduler/` and
`agents/` are sensitive paths, so the security review runs on the PR as spec
006 AC-9 says. Nothing here changes the sensitive-path list, the security
criteria, or what routes a sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the append-only assertion over the source and the every-kind assertion
    over the recorded chains (AC-1, AC-2);
  - index deletion and rebuild giving identical metric values (AC-3);
  - a backfill of a fixture state directory, run twice, with the second run
    recording nothing (AC-4);
  - the registry test over `agents/metrics/` (AC-5, AC-7, AC-8) and the seed
    values against `test/fixtures/events/expected.json` (AC-6);
  - recorded end-to-end runs (fake adapter, mocked GitHub) for: a delivery
    reflection woken by ten merges (and not by nine) whose result files three
    items, points one at an existing issue, applies one `set_parameter`,
    and creates a plan issue that closes the previous one; a charter
    reflection whose input marks a recurring contact and whose result files
    the automation item; a meta-reflection whose `metric_change` item is
    filed with its rationale and whose item without one is deferred; a result
    with twelve items of which eight are filed and four deferred; a crash
    after the plan issue is created, with the next run creating no second
    plan issue; a refused level-2 action from a reflection; the spec 006
    AC-28, spec 007 and spec 008 chains unchanged.
- After the service is restarted on the merged code: the backfill's counts,
  the first `panelator-scheduler metrics` output over the real history, and
  the first real run of each reflection agent (its plan issue, the issues it
  filed, and what it got wrong) are written up in `dev-logs/` with their run
  records.

## 7. Open decisions

None.
