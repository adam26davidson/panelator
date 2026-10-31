# 028. Reflection agents and plans as issues

Status: written 2026-10-31 by the split of spec 012 (ADR 0004): AC-1 to AC-10 here are
012's AC-11 to AC-20, amended for #69, #71 and #79; specs derived from the design need
no maintainer approval (delivery-system design section 11). Needs specs 026 and 027 on
`main`.
Class: tooling. Domain: backend.
Parent: docs/designs/metrics-reflection.md
Derives from: [metrics and reflection design](../../docs/designs/metrics-reflection.md);
[delivery-system design](../../docs/delivery-system-design.md) sections 3 ("What happens
while it waits"), 6.1 (the three reflection rows), 6.2, 7, 10 (staleness) and 11 (row D);
[charter](../../docs/charter.md) (self-improvement, meta-improvement, reflection with an
actionable plan, expanding what is automated); [design-tree](../../docs/design-tree.md)
R6.Q12, R7.Q2; [process-spec](../../docs/process-spec.md) sections 4.2 and 7 (superseded by
design section 7); [ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
(the split); builds on [026-event-store](../026-event-store/spec.md),
[027-metrics](../027-metrics/spec.md) and
[008-agent-registry](../008-agent-registry/spec.md) (standing agents, results applied in
code, issues filed as the App), and amends 008's AC-1 and AC-3 with the `min_events`
trigger field (AC-4 below).

What the maintainer decided, kept as it is here: reflection and meta-reflection choose and
change metrics over time; a metric change is a reviewed design change; each reflection
produces an actionable plan filed as App-authored `validated` issues; charter reflection
also reviews every maintainer contact in the period and files issues to automate recurring
ones.

## 1. Goal

Give the delivery system its mirror: three reflection agents on spec 008's registry.
Delivery reflection (weekly, or after a batch of merges) looks for bottlenecks and metric
trends. Charter reflection (weekly) judges the system against each charter clause and
reviews every maintainer contact. Meta-reflection (monthly) judges whether the metrics and
the reflections themselves are working. Each returns a plan; the scheduler posts the plan
as a record and files its items as App-authored `validated` issues, which the shortlist
then works.

## 2. Out of scope

- The console (spec E). Its Agents screen shows the three agents; no screen is designed
  here.
- Telegram delivery of plans or summaries (spec A's channel carries questions; a plan is a
  GitHub record, AC-6). Nothing is sent to the maintainer for a plan.
- Changing any metric (spec 027 and the reviewed PRs it describes); this spec files the
  proposal (AC-9).
- The event store and what it records (spec 026), beyond this spec's producers: a
  reflection's `issue.filed` through `createIssueRecorded`, `reflection.plan`, and the
  `metrics.snapshot` of a run.
- Changing the issue chain, its stages, bounds or transitions, the findings filer, the
  action audit or the parameter store, beyond the `min_events` trigger field (AC-4).
- Intake, grilling and the authority rule: unchanged. A reflection never posts to GitHub
  itself; the scheduler files from its result, as spec 008 AC-5 requires.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
The reflection agents run through spec 008's registry, runner, bounds, retry
and failure handling (spec 008 AC-3), and their results are applied by the
scheduler (spec 008 AC-5).

- AC-1. **Delivery reflection is a standing agent.**
  `agents/standing/delivery-reflection.md`: strong tier, Claude, `worktree:
  fresh` (it reads the charter, the designs, the specs, the metric
  definitions and the code), `trigger: { schedule: 7d, events: [merge],
  min_events: 10 }` (AC-4), bounds `timeout_min: 45`, `max_turns: 80`,
  `max_cost_usd: 8`, actions `set_parameter`, `pause_agent`, `resume_agent`,
  `run_agent`, input `reflection-input`, output `reflection-result`. Its
  prompt asks for the charter's bottleneck question: where does time go
  between a validated issue and a merge, which stages fail or loop, what the
  metric trends say about speed, delivery, quality, spend and autonomy, and
  what change would remove the largest bottleneck without lowering the bar;
  each finding becomes a plan item (AC-6). It also walks the design tree
  (design section 10, staleness) from the input's `design_tree` (AC-5): for
  every `docs/designs/<slug>.md` child path that has no file, and every merged
  spec whose issue has no merged implementation PR, it files one plan item
  (a finding, never an automatic rewrite), or states why not.
- AC-2. **Charter reflection is a standing agent.**
  `agents/standing/charter-reflection.md`: as AC-1 with `trigger: {
  schedule: 7d }` and the same actions. Its prompt walks the charter clause
  by clause (the input carries the charter's text split into clauses) and
  asks, for each: is the system meeting it, what evidence says so, and what
  change or new agent would meet it better; whether the console (absent
  until spec E, and the input says so) gives the maintainer the visibility
  and control the charter asks for; and, over the input's list of every
  maintainer contact in the period (AC-5), which kinds recur, filing one
  plan item per recurring kind to automate it (the charter's "expand the
  scope of what can be automated"). Given two or more contacts of the same
  `kind` and `label` in the period, then the input marks them as a recurring
  kind and the result must carry a plan item for it or a stated reason not
  to.
- AC-3. **Meta-reflection is a standing agent.**
  `agents/standing/meta-reflection.md`: as AC-1 with `trigger: { schedule:
  30d }`, actions none, and the extra input of AC-5. Its prompt asks whether
  each metric still tracks the charter goal it names (and whether a metric
  moved because the system improved or because the system learned the
  metric), whether the seed set misses a goal, whether the reflections'
  plans led to merged changes that moved the metrics, and whether the data the
  reflections decide on is adequate; a metric change it wants is a plan item
  with the write-up (AC-9), and a change to a reflection agent's prompt or
  cadence is a plan item too.
- AC-4. **An agent can wait for a batch of events.** Spec 008's `trigger`
  gains an optional `min_events` (an integer, at least 1, default 1), valid
  only with `events`. Given an agent whose trigger has `min_events: N`, then
  it is due on events only when its `pending_events` holds at least `N`
  events; a due schedule still runs it with whatever is pending, and a run
  clears what it received as spec 008 AC-3 says. The registry test of spec
  008 AC-1 accepts the key and rejects `min_events` under 1 or without
  `events`. The filer and the audit keep the default and are unchanged.
- AC-5. **The scheduler builds the input.** `reflection-input` is built by
  `tools/scheduler/src/reflection/input.ts` for the period from the agent's
  last successful run (or 28 days back on the first run) to now:
  - `period`, `agent`, `parameters` (the store), `agents` (every standing
    agent with its last run, next run, paused state and consecutive
    failures);
  - `metrics`: the report of spec 027 AC-5 for the period plus the previous 12 weeks,
    with each metric's `goal`, `description` and `rationale`;
  - `events_summary`: counts of events by kind and by week;
  - `issues`: for every issue with a `merge`, `issue.released` with reason
    `abandoned`, or `pause.started` event in the period, its timeline from
    the events: eligible, claimed and released times, each `chain.transition`
    with times, every `run.ended` with model, outcome and cost, its reviews,
    its questions and pauses, and its total cost. The list is complete and
    ordered by issue number: no `LIMIT` and no cap, since a period that has
    grown after failed runs (AC-10) is exactly the one in which nothing may
    be dropped; a test over an event set with 70 qualifying issues asserts
    70 timelines in the input;
  - `open_questions`: every `question` sent and not answered, with the issue,
    the asking stage, the question text and the time sent (design section 3:
    listed in each reflection plan);
  - `previous_plans`: the last plan of each reflection agent (AC-6) with,
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
    with `exists`, and per spec under `specs/` its path, status line,
    `issue` and `implemented`. No spec names its issue in its text, so the
    issue is derived: the squash commit that added the spec file (`git log
    --diff-filter=A -- <path>`, the oldest subject) ends with `(#<pr>)`, and
    the `merge` event whose `pr` is that number names the `issue`; `issue`
    is `null` when no such commit or event exists. `implemented` is `true`
    when the events hold a `merge` for that issue with a different `pr`
    (the implementation PR), `false` when they hold none, and `null` when
    `issue` is `null`. A test over a fixture repository with one spec added
    by a `(#N)` commit and the matching `merge` events asserts both values;
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
- AC-6. **A result is a plan, and the plan is a record.**
  `reflection-result` is `standing-result` plus `plan: { title, summary,
  observations: [{ what, evidence }], items: [{ title, body, class, kind,
  existing_issue? }], metrics_note, open_questions_note, deferred: [{ title,
  why }] }` where `kind` is `bottleneck`, `charter`, `automate_contact`,
  `metric_change`, `agent_change` or `other`, `class` is one of the class
  labels of `agents/scheduler.yaml`, and `body` states what to change, why
  (citing the evidence), and how to tell it worked (which metric or event
  should move).

  **The plan key.** Spec 008's run id changes on every attempt (it carries
  the attempt and the clock), so it cannot name a plan that a retry must
  find. Before a reflection agent's first attempt for a period, the
  scheduler writes `reflection: { period_from, plan_key }` into the agent's
  state record (`agents/<name>.json`, schema `agent-state.json`), with
  `period_from` the period start of AC-5 and `plan_key` equal to
  `<agent>-<period_from as epoch milliseconds>`. Whenever the state record
  already holds `reflection`, every later attempt reuses it as it is,
  whatever `failures` says: a retry after a failed attempt, and a rerun
  after the process died mid-apply (`running` set, `failures: 0`), both keep
  the same period and key. The field is cleared only when an attempt
  succeeds. Every "run id" in the markers, the plan file name and the
  `reflection.plan` payload below is this plan key; the attempt's run id is
  what the `run_id` envelope field and `agent.run` carry.

  Given a valid result, then the scheduler, in
  `tools/scheduler/src/reflection/apply.ts`, receiving the result, the plan
  key and the input it was built from:
  1. writes the plan to `reflections/<agent>/<plan key>.json` in the state
     directory;
  2. creates one plan issue as the App, titled `<Agent> plan <date>`,
     labelled `reflection` and the agent's name (`reflection:delivery`,
     `reflection:charter`, `reflection:meta`), never `validated`, whose body carries the
     summary, the observations, the metrics note, the open
     questions, the items with links to the issues filed, the direct actions
     applied in this run (design 6.1), and the deferred items (at this step the
     items are not filed yet, so they are listed without links; step 4 fills
     them in, because each item's body needs the plan's number, AC-7); it ends with
     the marker `<!-- panelator-reflection:<plan key>:plan -->`. The open
     questions section is built by the scheduler from the input's
     `open_questions` (AC-5), one line per question as `#<issue> (<stage>,
     sent <time>): <question text>`, or "None." when the list is empty, with
     the agent's `open_questions_note` under it; the note never replaces the
     list (a test with one open question in the events and a result whose
     note says "none" asserts the question appears in the body);
  3. files each item without `existing_issue` as an issue (AC-7), and for an
     item with `existing_issue` appends a comment to that issue linking the
     plan, ending with the marker `<!-- panelator-reflection:<plan key>:comment:<index> -->`,
     after reading the issue's comments so a retry does not comment twice;
  4. replaces the plan issue's body (`setIssueBody`) with the body of step 2
     built from this attempt's result and carrying a link to every item issue
     found or created;
  5. closes the previous plan issue of the same agent with a comment linking
     the new one, so one plan per agent is open at a time. The previous plan
     issue is the `plan_issue` of that agent's latest `reflection.plan` event
     (the index) whose plan key differs from this one; it is never looked up
     by label, because anyone with triage access can set a label. The scheduler
     reads that issue and closes it only when it is open and its author is the
     App; otherwise it leaves it and writes a service log line. A test labels a
     collaborator's issue `reflection:delivery` and asserts it is not closed;
  6. records `reflection.plan`, unless the index already holds one with this
     plan key, with the payload `reflection-plan.json`: the whole plan as filed,
     `plan_key`, `plan_issue` and the numbers of the issues filed (this spec
     tightens that kind in `schemas/scheduler/event.json`), and applies the result's `actions` and
     `findings` as spec 008 AC-5 does.

  Given a result with no items, then the plan issue is still created and
  says so. Given a crash after step 2, then the next attempt, at a later
  clock time, finds the plan marker on GitHub and does not create a second
  plan issue for that plan key; the item markers of AC-7 do the same for
  items. The found plan issue's body is replaced at step 4 from the new
  attempt's result, so it lists every item issue found or created rather than
  what the crashed attempt knew; an item issue found by its marker is left as
  it is. A test asserts the body after the retry names the items of both
  attempts. Two tests cover it, both with the fake clock advanced between the
  attempts: a thrown error after the plan issue (the retry path), and a
  process death after the plan issue with `failures` still 0 (the restart
  path, the state record carrying `running` and `reflection`).
- AC-7. **Plan items are validated issues the shortlist works.** Given an
  item, then the scheduler creates the issue as the App with the item's
  class label and `validated`, a body that opens with `Plan: #<plan issue>`
  and the item's `kind`, carries the item's body, and ends with the hidden
  marker `<!-- panelator-reflection:<plan key>:<index> -->`, searched for
  before creating as spec 008 AC-18 does. The issue has no `Spec:` line, so
  the chain starts at the spec stage (spec 006 AC-19), and the authority
  rule holds because the App is the author: every line of the item's body
  matching `^\s*Spec:` is removed before the issue is created, as the filer
  does (spec 008), so an item citing a spec cannot start the chain at the
  plan stage. Given more than 8 items without `existing_issue`, then the
  first 8 in the result's order are filed and the rest are written into the
  plan as deferred with the reason "over the plan bound", so a reflection
  cannot flood the shortlist; the bound is chain configuration
  (`agents/scheduler.yaml`, `reflection_max_issues`), not a prompt. The
  bound counts the items of the plan key that exist on GitHub, not the
  issues this attempt created: an item found by its marker counts toward
  it, so a retry after a crash at item 4 of twelve files items 4 to 7 and
  defers 8 to 11 (a test asserts it). Given an item whose `class` is not a
  class label, or whose body is under 200 characters, then the item is
  deferred with that reason and the rest of the result is still applied.
- AC-8. **Reflection never acts above level 1.** Given a reflection result
  whose `actions` carry a kind not in the agent's `actions` list, or level
  2, then it is refused and queued as spec 008 AC-8 says. Given a result
  whose plan item asks for a change to `docs/charter.md`, then the item is
  still filed (the chain's spec stage will return it as a question or the
  review will reject it; design section 5), and the plan issue marks it
  "charter change: needs the maintainer". No reflection result changes a
  metric, an agent definition, a parameter's mode or any repository file
  directly: a test asserts that `reflection/apply.ts` writes only under the
  state directory and calls only these GitHub operations: `createIssue` through
  `createIssueRecorded`, `comment`, `listComments`, `closeIssue`,
  `setIssueBody`, `searchOpenIssuesByMarker`, and the read of one issue's state
  and author (section 5).
- AC-9. **A metric change is proposed, not made.** Given a plan item with
  `kind: metric_change`, then its body must carry a `## Rationale` section
  (the design write-up) and name the metric it replaces or adds; the filed
  issue carries it, and the spec stage that works the issue writes the
  definition file (spec 027 AC-1) and, when it replaces a metric, sets `replaces` so
  the overlap of spec 027 AC-3 applies. Given a `metric_change` item without a
  rationale section, then it is deferred with that reason.
- AC-10. **A reflection that fails is not silent.** Given a reflection run
  that fails twice (spec 008 AC-3), then the finding and notification spec
  008 writes name the agent, and the next scheduled run uses the same period
  start (the last successful run), so no period is skipped; each failed
  attempt has its own `agent.run` event (spec 026 AC-2). Given a plan
  whose filed issue is later abandoned (spec 006 AC-5), then the next plan's
  `previous_plans` input shows it as `abandoned`, so the reflection sees the
  outcome of what it asked for.

## 4. Design notes (agent's calls)

- **A plan is a GitHub issue that is never worked.** The design says plan items come out
  as issues linked to the plan, so the plan needs a stable thing to link to that the
  maintainer can read from a phone today; an issue labelled `reflection` and not
  `validated` is that, costs no new storage, and the shortlist ignores it (the validated
  gate). The state directory keeps the JSON for the inputs of later reflections.
- **The plan body is edited once.** AC-6 asks the plan to link its items and AC-7 asks each
  item to name its plan, so one of them is written after the other; the plan is created
  first and its body is replaced at step 4 (#71). The same step is what makes a retry's
  body complete (#79).
- **The predecessor is the recorded number (#69).** Process-spec 4.3 keys authority on the
  App's authorship in code, not on labels anyone with triage access can set.
- **Eight issues per plan.** Reflection is weekly; eight per agent per week is more than the
  chain merges. A bound in configuration, with the overflow written into the plan, is what
  keeps a verbose model from drowning the shortlist while losing nothing it said.
- **`min_events` rather than a new event.** "After N merges" is a property of the trigger,
  and spec 008's pending-events list already holds the merges; a counter in the definition
  is one field and no new producer.
- **The reflection's reach is spec 008's level 1.** The design lists what a plan may apply
  directly (6.1: level 1 changes, listed in the plan); the agents get the parameter and
  agent-pause kinds and nothing that writes the repository. Everything else is an issue, so
  the chain's review is the gate on the system changing itself, as the design wants.
- **The issue list has no cap.** A hidden `LIMIT` drops the issues with the highest numbers,
  the most recent ones, on the period where it matters most; a strong-tier model reads a few
  dozen compact timelines without trouble, and the weekly cadence bounds the period in the
  normal case.
- **Charter changes are filed, not swallowed.** A reflection may well conclude the charter
  should change; the design's path for that is a question to the maintainer (section 5), and
  the chain's spec stage and question check are already the way a question is raised. Filing
  the item and marking it keeps the trail honest without giving the reflection a new channel.

## 5. Interfaces and files

The paths in backticks are what the scope gate reads: a sensitive file in the diff passes
only if it is listed here in full (exactly, or under a listed entry ending in `/`).

**Plan scope.** The plan for this spec lists as prefix entries (the scope gate accepts an
entry ending in `/`): `tools/scheduler/src/reflection/`, `tools/scheduler/src/standing/`,
`tools/scheduler/src/events/`, `tools/scheduler/src/state/`,
`tools/scheduler/src/github/`, `tools/scheduler/test/`, `agents/standing/` and
`schemas/scheduler/`. It also lists by name `tools/scheduler/bin/scheduler.ts`,
`tools/scheduler/src/service/loop.ts`, `tools/scheduler/src/config.ts`,
`tools/scheduler/src/types.ts`, `tools/scheduler/src/schema/validate.ts`,
`tools/scheduler/src/filer/input.ts`, `agents/scheduler.yaml` and `tools/README.md`.

- `tools/scheduler/src/events/store.ts` and `tools/scheduler/src/events/kinds.ts`: the
  `reflection.plan` entry of the payload schema map (AC-6). Spec 026 owns the rest of that
  directory; `createIssueRecorded` and `openIndex` are used as they are.
- `tools/scheduler/src/state/paths.ts`: `reflections/`. Other files under
  `tools/scheduler/src/state/` and `tools/scheduler/src/filer/input.ts` change only if the
  input of AC-5 needs a reader exported (`findings_pending`, `open_questions`).

- `tools/scheduler/src/reflection/`: `tools/scheduler/src/reflection/input.ts` (AC-5,
  including the charter clauses, the maintainer-contact grouping, the issue timelines and the
  previous plans), `tools/scheduler/src/reflection/apply.ts` (AC-6 to AC-9: the plan file, the
  plan issue and its rewrite, the item issues with markers, the bound, the predecessor close).
  Further helpers there are the implementer's call.
- `tools/scheduler/src/standing/run.ts`: the plan key, the reflection input and apply dispatch
  (AC-5, AC-6); `tools/scheduler/src/standing/registry.ts`,
  `tools/scheduler/src/standing/state.ts` and `tools/scheduler/src/types.ts`: the `min_events`
  trigger field and the due rule (AC-4); `tools/scheduler/src/standing/state.ts` and
  `schemas/scheduler/agent-state.json`: the `reflection` field (AC-6).
- `tools/scheduler/src/service/loop.ts`, `tools/scheduler/bin/scheduler.ts`: passing the metric
  definitions to the standing runner. `tools/scheduler/src/config.ts`: `reflection_max_issues`
  (AC-7). `tools/scheduler/src/schema/validate.ts`: the new schema names.
- `tools/scheduler/src/github/client.ts`: the GitHub operations of AC-8. `createIssue`,
  `comment`, `listComments`, `closeIssue`, `setIssueBody` and `searchOpenIssuesByMarker` exist;
  this spec adds the read of one issue's state, author and linked PR (for `previous_plans` and
  the predecessor's author check), with full pagination (process-spec 6.4), and
  `tools/scheduler/src/github/types.ts` as that needs. No listing by label is used to find a
  plan.
- `agents/standing/delivery-reflection.md`, `agents/standing/charter-reflection.md`,
  `agents/standing/meta-reflection.md` (AC-1 to AC-3).
- `agents/scheduler.yaml`: `reflection_max_issues: 8` (AC-7). The labels `reflection`,
  `reflection:delivery`, `reflection:charter` and `reflection:meta` need no code: GitHub
  creates a label on its first use, which is how the claim label came to exist, and
  `tools/README.md` adds them to the list of labels the repository carries.
- `schemas/scheduler/`: `schemas/scheduler/reflection-input.json`,
  `schemas/scheduler/reflection-result.json`, `schemas/scheduler/reflection-plan.json`;
  `schemas/scheduler/standing-definition.json` gains `trigger.min_events`;
  `schemas/scheduler/event.json`: the payload of `reflection.plan` (AC-6).
- `tools/scheduler/test/`: `tools/scheduler/test/reflection.test.ts` (input building from the
  fixture events, recurring contacts, plan issue and item markers, the body rewrite, the bound
  and deferrals, the predecessor by recorded number and author, charter-change marking, the
  write-only-under-state assertion, metric-change rationale, the complete `issues` list), the
  registry test over `agents/standing/`, `min_events` in
  `tools/scheduler/test/standing.test.ts`, the recorded runs of section 6 in
  `tools/scheduler/test/e2e.test.ts`, the empty constant of spec 026 AC-2 in
  `tools/scheduler/test/events.test.ts`, the routes for issue creation, comments, closing,
  body edit, marker search and issue state in `tools/scheduler/test/helpers/e2e-routes.ts`
  with the fake clock advanced between attempts, and
  `tools/scheduler/test/fixtures/stage-script.ts` when a run needs a new scripted result shape.
  The fixture repository of AC-5's `design_tree` test is built in a temporary directory by the
  test (as `tools/scheduler/test/helpers/repo-pair.ts` does), not checked in.
- `tools/README.md`: the three agents and what a plan issue is.

No file outside `tools/scheduler/`, `agents/standing/`, `agents/scheduler.yaml`,
`schemas/scheduler/`, `tools/README.md` and `dev-logs/` is changed by the implementation.
`tools/scheduler/` and `agents/` are sensitive paths, so the security review runs on the PR as
spec 006 AC-9 says. Nothing here changes the sensitive-path list, the security criteria, or
what routes a sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean, including:
  - an input over 70 qualifying issues carrying all 70 timelines (AC-5), and `design_tree` over
    the fixture repository (AC-5);
  - the every-kind assertion of spec 026 AC-2 with its not-yet-produced constant empty;
  - recorded end-to-end runs (fake adapter, mocked GitHub) for: a delivery reflection woken by
    ten merges (and not by nine) whose result files three items, points one at an existing issue,
    applies one `set_parameter`, and creates a plan issue that closes the previous one; a charter
    reflection whose input marks a recurring contact and whose result files the automation item; a
    meta-reflection whose `metric_change` item is filed with its rationale and whose item without
    one is deferred; a result with twelve items of which eight are filed and four deferred; the
    same twelve-item result crashing at item 4 and retried, with items 4 to 7 filed and 8 to 11
    deferred and the plan body linking all eight (AC-6, AC-7); a crash after the plan issue is
    created, with the next attempt at a later clock time creating no second plan issue, once as a
    thrown error and once as a process death with `failures` still 0 (AC-6); a retried comment on
    an `existing_issue` appearing once (AC-6); a reflection that fails once and succeeds on retry,
    with two `agent.run` events (AC-10); an open question in the events listed in the plan body
    (AC-6); a collaborator's issue carrying `reflection:delivery` left open (AC-6); a refused
    level-2 action from a reflection (AC-8); the spec 006 AC-28, spec 007 and spec 008 chains
    unchanged.
- After the service is restarted on the merged code: the first real run of each reflection agent
  (its plan issue, the issues it filed, and what it got wrong) is written up in `dev-logs/` with
  its run records.

## 7. Open decisions

None.
