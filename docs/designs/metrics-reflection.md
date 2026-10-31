# Event store, metrics and reflection

Status: written 2026-10-31 when spec 012 was split (ADR 0004); row D of the
delivery-system design's section 11 is this design. Its children are built in
the order listed under `## Children`.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../delivery-system-design.md) sections 3
("Recording"), 6.1 (the three reflection rows), 6.2, 7, 11 (row D) and 13;
[charter](../charter.md) (metrics, self-improvement, meta-improvement,
reflection with an actionable plan, expanding what is automated);
[design-tree](../design-tree.md) R6.Q12, R7.Q2;
[ADR 0002](../decisions/0002-event-store-jsonl-with-sqlite-query-index.md) (the
store); [ADR 0004](../decisions/0004-split-metrics-reflection-spec.md) (the
split).

## 1. Intent

Give the delivery system its memory and its mirror: a raw event store, metrics
derived from it as queries, and three reflection agents whose plans become
issues the chain builds. One spec held all three and its implementation did not
fit the bounds of one chain (ADR 0004), so each is now its own spec, PR and
chain.

## 2. What the maintainer decided

Recorded on issue #15, quoted as written there:

> Maintainer decisions: record everything raw and derive metrics as queries; reflection and meta-reflection choose and change metrics over time (a metric change is a reviewed design change; replaced metrics keep running beside the new one for a few weeks); each reflection produces an actionable plan filed as App-authored `validated` issues; charter reflection also reviews every maintainer contact and files issues to automate recurring ones.

And in the delivery-system design, section 7, which this design does not change:

> The maintainer chose that metrics are discovered and changed by the reflection agents as the project moves through stages, not fixed up front.

The split changes how the work is delivered. It changes none of these, nor any
statement design section 5 protects.

## 3. The split

| Order | Spec | Delivers | Readers it serves | Sized from the closed PR's patch |
|---|---|---|---|---|
| 1 | 026 Event store and recording | `recordEvent`, the index, backfill, every recording call, `createIssueRecorded` | 027, 028, F1 | about 1,050 changed lines, 37 files |
| 2 | 027 Metrics as queries | definitions, seed set, report, `metrics` and `events query` commands | 028, E, the maintainer | about 1,000 lines, half of it fixtures and YAML, 18 files |
| 3 | 028 Reflection agents and plans as issues | `min_events`, the three agents, input, plan issue, item issues | the shortlist, the maintainer | about 1,400 lines, 20 files |

Each child merges on its own, on top of the ones before it, and leaves `main`
working:

- **026 has no consumers to break.** It adds calls beside existing writes. The
  event kinds of later specs are valid names with no producer, as `aws.cost`
  already is, and the test that every kind is recorded names them in one
  constant.
- **027 only reads events.** Its one write is the `metrics.snapshot` of
  `metrics --snapshot`. A bad definition stops the service at start, as a bad
  config does, and CI catches it first.
- **028 adds agents through spec 008's registry.** Until it lands no plan issue
  exists and nothing waits for one.

### Contracts between the children

- The event envelope, the kind list and `openIndex` belong to 026. 027 and 028
  tighten the `metrics.snapshot` and `reflection.plan` payload schemas as they
  add the producers, and change nothing else in `schemas/scheduler/event.json`.
- `createIssueRecorded` belongs to 026. The one-caller test holds from 026 on,
  so `reflection/apply.ts` in 028 cannot call `createIssue` directly.
- The report `computeMetrics` returns, and the one function that records a
  snapshot, belong to 027. 028's input and spec E's History screen consume them.

## 4. Where each criterion of spec 012 went

Every acceptance criterion of spec 012 moved to exactly one child; none was
dropped. Section 2, 4 and 6 text moved with the criteria it served.

| Spec 012 | Now | Spec 012 | Now |
|---|---|---|---|
| AC-1 | 026 AC-1 | AC-11 | 028 AC-1 |
| AC-2 | 026 AC-2 | AC-12 | 028 AC-2 |
| AC-3 | 026 AC-3 | AC-13 | 028 AC-3 |
| AC-4 | 026 AC-4 | AC-14 | 028 AC-4 |
| AC-5 | 027 AC-1 | AC-15 | 028 AC-5 |
| AC-6 | 027 AC-2 | AC-16 | 028 AC-6 |
| AC-7 | 027 AC-3 | AC-17 | 028 AC-7 |
| AC-8 | 027 AC-4 | AC-18 | 028 AC-8 |
| AC-9 | 027 AC-5 | AC-19 | 028 AC-9 |
| AC-10 | 027 AC-6 | AC-20 | 028 AC-10 |

## 5. Gaps found in spec 012, now settled in the children

| Issue | Gap | Where it is settled |
|---|---|---|
| #71 | `setIssueBody` and `listComments` not named | 028 AC-6 (steps 3 and 4), AC-8, section 5 |
| #71 | `prs` on `issue.filed` | not added: the payload carries `body`, 026 section 4, and 027 AC-2 defines a citation |
| #71 (comment) | AC-1 and AC-4 contradict on an old-shape payload | 026 AC-1, AC-4: `recordBackfillEvent` |
| #71 (comment) | when `issue.eligible` is recorded, and where queue wait comes from | 026 AC-2 |
| #71 (comments) | the driver named as recording `issue.filed` for escalation issues it does not file | 026 AC-2, section 5 |
| #71 (comment) | a Telegram notifier that does not exist | 026 AC-2, section 5 |
| #71 (comment) | reflection labels "created by the scheduler" with no such code | 028 section 5 |
| #69 | the previous plan found by label | 028 AC-6 step 5 |
| #79 | a plan found on retry keeps the crashed attempt's body | 028 AC-6 step 4 and the crash clause |
| #82 | every `openIndex` writes, with no busy timeout | 026 AC-3, section 4 |

## Children

- `specs/026-event-store/spec.md`
- `specs/027-metrics/spec.md`
- `specs/028-reflection-agents/spec.md`
