# Delivery system design: no human gate on the path to main

Status: design agreed with the maintainer in a brainstorming session,
2026-10-18 to 2026-10-20. Derives from [charter.md](charter.md). Supersedes the
human gates in [process-spec.md](process-spec.md) sections 3 and 5 and in
[specs/001-scheduler-core](../specs/001-scheduler-core/spec.md) sections 3, 5
and 8. It is broken into specs in section 11. Calls the maintainer made are
stated plainly. Calls made by the design author and not discussed with the
maintainer are marked *(author's call)*; the builder may revisit those with a
reason.
Parent: docs/charter.md

## 1. Intent

The [charter](charter.md) asks for a system that delivers the product on its
own, improves itself, and needs the maintainer only for high-level direction.
Today the scheduler stops for a human in about ten places (`needs-human`,
`needs-spec`, `needs-design`, `needs-clarification`, `security-review`, the
automation-change gate, spec approval). Every one of those either goes away or
becomes work for an agent. The pipeline gains standing agents, measurement,
reflection, reach beyond GitHub, and a console where the maintainer sees and
steers it.

## 2. Goals, non-goals, anti-goals

Goals:

- No part of the path from a filed issue to a merge on `main` waits on a
  human, except for the three kinds of question in section 3.
- The system adds its own agents, changes its own code and process, picks its
  own metrics, and acts directly on operational problems.
- The maintainer is reached on Telegram and can answer in seconds; the system
  resumes immediately on a reply.
- The maintainer can see the system's state and history, and set or lock its
  parameters, from a phone, tablet or desktop.

Non-goals:

- Changing the product's own hosting, budget or degradation ladder
  ([product-spec](product-spec.md) 5.4, 5.5). Those stay as specified.
- Community-filed intake. The authority rule (only issues from the pipeline's
  bot are worked) stays.
- Designing the console's final look here. Mockup A (section 9) is a
  direction; the console's own design stage produces the design.

Anti-goals (failure even if everything technically works):

- The system drifts from the charter, or edits it.
- The maintainer is asked things an agent could have decided.
- An agent quietly makes a product decision, or an uncertain large technical
  one, that was the maintainer's.
- The system games its own metrics: success is redefined so the numbers look
  better.
- The delivery system's spending touches the product's budget, or the reverse.
- An agent contacts a new outside party without the maintainer's approval.

## 3. When the system reaches the maintainer

Only for:

1. **Product decisions.** Big-picture choices about what panelator is and
   what it promises its users: audience, scope and non-goals, built-in
   widgets, milestones, trust and privacy promises, money and hosting (the
   kinds of decision recorded in `product-spec.md`). That a user could
   notice a change does not make it a product decision: a slightly slower
   response, a layout or wording choice within an agreed design, or any
   other detail that keeps the product's promises is decided by agents (UI
   and UX detail by the design stage and its visual review).
2. **Large technical decisions with real uncertainty.** Large means costly to
   reverse (language, runtime, database, major structure). Real uncertainty
   means sensible options remain after the agent's own investigation, and the
   choice turns on the maintainer's priorities or direction. A large decision
   with one clearly right answer proceeds on the agent's judgement and is
   recorded as an ADR in `docs/decisions/` with its reasoning.
3. **What agents cannot do.** Physical actions (recovering a bricked test
   board), credentials and access, funds, and first contact with a new outside
   party (section 7).

Every other blocker is resolved by agents (section 4).

**Who judges.** The agent that wants to ask writes the question; a second
independent reviewer (section 6.3) checks that it belongs in one of the three
kinds above before it is sent. If it does not, it goes back to the asking agent
as "decide it yourself", with the reviewer's reasoning. *(author's call)*

**What a question looks like.** A short proposal from the strongest available
model: the options, the cost of each, and a recommendation (as process-spec
4.2 step 3 already describes for design flaws). Simple choices carry Telegram
reply buttons; free text always works. *(author's call on buttons)*

**What happens while it waits.** The work that raised the question stops until
the maintainer answers. It releases its concurrency slot so other work
continues. On a reply it returns to the shortlist ahead of everything else and
resumes where it stopped. If unanswered for 24 hours, one reminder is sent.
After that it stays paused, listed on the console's Questions screen and in
each reflection plan, and is never abandoned without the maintainer. A reply
that is itself a question or a request for more detail gets a follow-up from
the stage that asked, and the work stays paused; such an exchange does not
count against any bound.
*(author's call: slot release, priority on resume, reminder, no timeout,
follow-ups)*

**Recording.** Every question and answer is logged in the questions log
(feeds the "questions per week" and "answered 'obvious, just do it'"
measurements, which tune the threshold), and the decision is written where it
belongs (section 10): a product answer into `product-spec.md` or the relevant
top design, a technical answer into the spec or an ADR. Every recorded answer
is marked with its question comment id. *(author's call: the marking)*

## 4. The chain with no human stops

Replaces the `needs-human` rows of spec 001 section 5 and the gates in section
8 that route to a human.

| Situation (spec 001 today) | New behaviour |
|---|---|
| plan or implement failed twice; scope violated twice; fix loop exhausted (`needs-human`, AC-10, AC-13) | **Rescue:** one more attempt on the strongest model with the full history of attempts, results and review findings. If it fails: the PR is closed and its branch saved as a patch, and the issue is planned again from scratch. If re-planning also fails: the issue goes to the spec agent, on the theory that the spec is wrong. If the spec agent finds nothing to change, it may escalate as a large technical question; if the section 3 check sends that back as "decide it yourself", the spec agent must pick an approach and the chain runs once more on it. If that fails too, the issue is labelled `abandoned` with the full record and left open for spec C to re-triage, a finding is filed, and delivery reflection picks it up. The maintainer is told, for information only, with no request to act; C's re-triage is the recovery path. *(author's call: the terminal state)* |
| review returns `escalate` | The review result must carry a reason classified as one of section 3's kinds, or as "other". A section 3 kind goes to the maintainer; "other" becomes input to a rescue attempt. |
| security finding on a sensitive path (AC-11, `security-review`) | Fix loop with the finding as input, then a fresh security review by an independent reviewer (section 6.3). Reaches the maintainer only if a finding raises a section 3 question. |
| `needs-spec`, `needs-design` (AC-7, AC-8) | Work for the spec agent: write or complete the spec, or run the design stage to produce the design artifacts. |
| plan returns `spec_gap` (AC-9, `needs-clarification`) | The spec agent answers each question. Technical answers are written into the spec and marked as the agent's call. Only section 3 questions reach the maintainer. |
| spec approval by the maintainer (process-spec 3) | The maintainer's sign-off is the grilling session, where direction is set. The spec drafted from it is checked by an agent against the grilling record. Bug, debt and tooling specs, and the system's specs for its own work, never need the maintainer unless they contain a section 3 question. |
| automation-change gate (AC-12) | Removed. Changes to `tools/scheduler/` and `agents/` go through normal review plus the protections in section 5. |
| authority gate (AC-6) | Unchanged: it is intake defence, not a merge gate. |

The **spec agent** is a new agent stage, strong tier. *(author's call: one
agent for spec writing, spec gaps and design-artifact requests; the builder may
split it.)*

Bounds still apply: a rescue, a re-plan and a spec revision are each counted
per issue, and the counts are chain configuration like the existing fix bound,
not something a prompt can change.

## 5. The charter and self-modification

- `docs/charter.md` is the only document agents may not change. Requests to
  change it go to the maintainer on Telegram (charter, last paragraph).
- **Enforcement is by AI review, as the maintainer chose.** No GitHub ruleset.
  `docs/charter.md` is added to `agents/sensitive-paths.txt`, so any PR
  touching it gets the security review profile, whose instructions say to
  reject any change to the charter. *(author's call: the sensitive-path route)*
- Everything else, including the scheduler, `agents/`, the process spec, and
  this document, may be changed by the system through a reviewed PR. Changes to
  the scheduler and `agents/` must keep the recorded end-to-end chain tests
  passing, and are reviewed by an independent reviewer (section 6.3).
- **The maintainer's recorded decisions are protected.** Protected are: the
  statements in this document not marked *(author's call)*, section 3 itself,
  the recorded product decisions in `product-spec.md`, and the decision entries
  in `docs/design-tree.md`. Not protected are statements marked *(author's
  call)* and the editorial and tracking parts (the section 11 table, section
  12, the children lists); those change with an ordinary reviewed PR. A change
  to a protected statement is a section 3 question, always sent to the
  maintainer by the question check. A PR may otherwise change one only by
  citing a maintainer answer the scheduler can verify: an answered entry in the
  questions log, referenced by its question comment id. `docs/product-spec.md`,
  `docs/design-tree.md` and this document are added to
  `agents/sensitive-paths.txt`, so the security review enforces it (spec 006).
  *(author's call: the mechanism)*
- process-spec section 5's "changes to the automation need a human-approved
  spec, always" is replaced by the points above.

**Firmware and the test board.** Firmware is tested on a real test board
attached to the laptop (the HIL rig, process-spec 6.1). process-spec 5's "one
human release action" is removed. Until spec G lands there is no promotion
from beta to stable at all; once it lands, promotion is automatic when the
board's tests pass, under G's criteria. If a test bricks the board, recovery is a
physical action: the system tells the maintainer and pauses firmware work until
the maintainer confirms the board is back. *(author's call: the pause)* The
criteria for automatic promotion (which HIL tests, any soak time on beta) are
left to the spec that builds it.

## 6. Standing agents and how far they may act

### 6.1 Registry

The scheduler runs more than the issue chain. Each standing agent is a file
under `agents/` (alongside today's `agents/stages/`), with its trigger
(schedule or event), harness, model, bounds, input and output schemas. Adding
a file adds an agent; the system creates agents itself by PR, without the
maintainer's approval. *(author's call: file-per-agent format, mirroring stage
definitions)*

Event triggers include at least: a merge, a finding appended to the queue, a CI
failure on `main`, an infrastructure alarm, a maintainer reply, a credential
nearing expiry.

Initial roster:

| Agent | Woken by | Produces |
|---|---|---|
| Issue chain | a shortlisted issue | merged PRs |
| Spec agent | the chain (section 4) | spec edits, design artifacts, questions |
| Findings filer | new records in the findings queue | issues, discards with reason, escalations (process-spec 4.2) |
| Infra health | alarms, plus a periodic sweep | direct actions, findings (the ops-watcher slot of process-spec 4.4) |
| Credential check | daily, and before known expiry dates | early Telegram warnings; automated renewals where possible |
| Delivery reflection | weekly, or after N merges | a plan: bottlenecks and metric trends |
| Charter reflection | weekly | a plan: the system against each charter clause, including whether new agents are needed and whether the console (section 9) still gives the maintainer the visibility and control the charter asks for; and a review of every time the maintainer was contacted in the period, filing an issue to automate each recurring kind (the charter's "expand the scope of what can be automated") |
| Meta-reflection | monthly | a plan: whether the metrics and the reflections themselves are working |
| Action audit | periodically | findings about direct actions that went wrong |

Schedules are parameters (section 9). *(author's call: the initial
cadences above)*

**A reflection's plan is actionable** (charter): it comes out as issues, each
linked to the plan, which the chain then builds. Changes that fit level 1
below may be applied directly and are listed in the plan.

### 6.2 Three levels of action

1. **Act directly.** Operational and reversible, within limits that already
   exist: restart a service, rerun a job, scale resources within the AWS cap,
   rotate a credential, change a parameter set to auto, pause an agent.
2. **Reviewed PR.** Anything that changes repository content: code, agent
   definitions, specs, the process spec, the scheduler. Bigger directional
   changes (a new agent, a redesigned stage, a new metric) carry a design
   write-up in the PR, and review judges the design as well as the code.
   A PR that adds an agent, a parameter or a metric includes its console
   exposure (section 9), or files an issue for it, so the console keeps up
   with the system. *(author's call)*
3. **Ask the maintainer.** Section 3.

Guards on level 1 *(author's calls)*:

- Every direct action is recorded: what, why, which agent, and how to undo it.
- Locked parameters and the AWS cap cannot be changed by the system. The
  scheduler enforces this in code, not in a prompt. The maintainer trusts the
  system to keep honouring locks even though it can change that code through
  reviewed PRs; no store outside the system's reach is built for now.
- The action audit agent reviews the log; a kind of action that goes wrong
  repeatedly is moved to level 2.

### 6.3 Independent reviewers

Wherever this document asks for an independent reviewer (the section 3
check, security re-review, review of changes to the scheduler and `agents/`),
what is required is a fresh session with no context from the work under
review. A model from the other vendor is used when its quota allows; the
maintainer does not plan to grow the OpenAI plan for this, so the normal
fallback is a Claude model, and the same Claude model in a fresh session
counts as independent. Which one was used is recorded with the review. pi
reviewers run with spec 004's read-only tool default; container isolation is
needed only before pi runs write-capable stages unattended. *(author's call
on the last point)*

## 7. Measurement

- **Raw events, derived metrics.** Every run, stage, merge, CI result, review,
  finding, direct action, question and answer, queue and shortlist wait time,
  time paused waiting on the maintainer, concurrency slot occupancy, and AWS
  cost record is stored as a raw event and never discarded. A metric is a query over those events, so a
  new metric can be computed back over the whole history. This replaces
  process-spec 7's "raw events in the backend's Postgres": the delivery
  system's data lives in its own store, separate from the product's backend.
  *(author's call: separation; the store itself is left to the builder)*
- **Reflection chooses metrics.** The maintainer chose that metrics are
  discovered and changed by the reflection agents as the project moves through
  stages, not fixed up front.
- **Seed set,** so reflection has a starting point on day one *(author's
  call)*: issue-to-merge time (speed), merged issues per week split product vs.
  system (delivery), rework and post-merge defects (quality), cost per merged
  issue (spend), and questions to the maintainer per week (autonomy).
- **Against gaming.** A metric change is a level 2 change with a design
  write-up. The reviewer judges it against the charter's goals, not against
  whether the numbers improve. A replaced metric keeps being computed beside
  its replacement for a few weeks, so a jump caused by the switch alone is
  visible. Meta-reflection's main job is to check that the metrics still track
  what the charter asks for. *(author's calls)*

## 8. Beyond GitHub

**Telegram.** Scope for spec A is the question conversation: a question,
the maintainer's replies, the agent's follow-ups, pushback, until the
decision is settled. Intake and grilling over Telegram (process-spec 4.1, 6.3)
are a later spec. *(author's call)* The "grilling record" that spec B's
check reads is what process-spec 4.1 already prescribes: the GitHub issue the
grilling session posts, carrying the design tree and spec draft.

The scheduler (or a companion service, process-spec 6.3 already
specifies a persistent long-polling process) holds a Telegram long-poll
connection open at all times. A reply wakes the system immediately; there is
no timer. The reply resumes the agent session that asked, with its context,
which answers in the same thread within seconds. If the laptop was asleep,
Telegram holds the update and the system picks it up on wake and says so.
*(author's call: the "picked up your reply" message)* Telegram carries
questions, credential and fund requests, first-contact requests, alerts and
reminders.

**AWS for the delivery system.**

- The delivery system gets its own AWS account in the same organization as the
  product's. The charter's monthly cap applies to that account only; the
  product's spend is governed by product-spec 5.5. Agents may operate the
  product's account (for example infra health restarting a service) within the
  product's rules. *(author's call: separate accounts)*
- The cap is enforced by AWS Budgets: an alert to the maintainer at 80%, and at
  100% a budget action that blocks creating new resources, which the system's
  own code cannot override. Because AWS cost data lags up to a day, the
  scheduler also keeps its own running estimate and stops launching new
  resources before the line. *(author's calls)*
- Before launching anything, an agent states the expected monthly cost; if it
  does not fit under what is left, it becomes a funds request instead.
- The system forecasts the month's spend daily and acts early when the
  forecast exceeds the cap: shrinking or stopping what it does not need, or
  asking for budget days ahead. The maintainer expects good planning to make
  hitting the cap rare.
- The laptop stays a working fallback home: whatever moves to the cloud, the
  system keeps the ability to run on the laptop again, so a missed forecast
  means slower, not stopped. Hitting the actual cap is an incident sent to the
  maintainer and treated by reflection as a planning failure.
- Token spend is bounded by the maintainer's Anthropic and OpenAI
  subscriptions (charter); no separate cap.

**Credentials** *(author's calls)*: kept in an encrypted store on the laptop;
agents use them through wrappers, as with today's `gh` wrapper, and never see
the secret. A request names the exact access needed and gives step-by-step
setup. Least privilege. The credential check automates renewal wherever the
provider allows.

**Funds.** Requested from the maintainer on Telegram, with what for, the amount,
and the charter goal it serves.

**First contact.** Before an agent contacts any outside party for the first
time (a vendor, a support desk, a contributor), it asks the maintainer on
Telegram: who, why, and what it would send. Once approved, later contact with
that party proceeds. This is the maintainer's choice "for a start" and is a
locked parameter, `first_contact_needs_approval`, on by default.

## 9. The console

The maintainer's interface (charter). Built for **mobile, tablet and desktop**;
every screen is designed and reviewed at all three sizes.

- **Home, direction "A" (chosen by the maintainer from three mockups):** a
  banner for open questions to the maintainer; one large card for the
  current issue with its stage progress (plan, implement, verify, review, fix,
  merge), model, elapsed time and cost so far; "up next"; then four stat
  tiles (merged per week, median issue-to-merge, rework, AWS spend against
  the cap). On wider screens the extra width is the design stage's to use.
- **Other screens** *(author's call on the set)*: Questions (open and answered,
  linked to the Telegram thread and the decision record); History (metrics
  over time, including old and new side by side after a metric change);
  Actions (the direct-action log, each with undo); Agents (last run, next run,
  cost, pause); Parameters (each with an auto or locked switch).
- **Parameters at the start** *(author's call on the list and values)*: AWS cap
  (locked); ratio of work on the system vs. the product (auto, starting with
  most work on the system as the charter allows; replaces process-spec 4.5's
  fixed 2:1); agent schedules (auto); concurrency slots (auto);
  `first_contact_needs_approval` (locked, on). The system may add parameters.
  The parameter store (auto and locked, enforced in code) and the shortlist's
  use of the ratio belong to spec C; the console shows and sets them.
- **Hosting and access** *(author's calls)*: hosted in the delivery system's
  own AWS account, counted against its cap. Nothing connects in to the laptop:
  the scheduler pushes state to the console, and changes made in the console
  (a parameter, an undo, a pause) are pulled by the scheduler over a held-open
  connection, as with Telegram. Sign-in with GitHub, allowed only for the
  maintainer's login.
- **Design first.** Per the charter, the console goes through a dedicated
  design stage with design tools and visual review by the model before
  implementation. This makes the console the first job of the design stage
  (section 11, spec E). Mockup A is that stage's input, not its output.
- **Package.** A delivery-system package separate from `web/`, reusing the web
  app's React toolchain so there is one front-end stack. *(author's call)*

## 10. Design hierarchy

The maintainer chose to formalize how direction becomes code: designs split
into sub-designs or specs, specs into plans, plans into PRs. Every artifact has
exactly one parent, so the system can trace any change up to the charter and
any design down to the code it produced.

```
docs/charter.md                         root; only the maintainer changes it
├── docs/product-spec.md                top design for the product
│   ├── designs, any depth
│   │   └── specs/NNN-<slug>/spec.md
│   └── specs (small work may hang directly off a top design)
└── docs/delivery-system-design.md      top design for the delivery system
    └── ... same shape
spec ──> plan (state directory, issue comment) ──> PR
```

Rules:

- **One document type for designs, any depth.** A design states its parent and
  lists its children, each a design or a spec. Each child names its parent.
  Sub-designs live in `docs/designs/<slug>.md`. *(author's call: location)*
  The two top designs stay where they are.
- **A design must have at least two children;** a design with one child is a
  spec and is written as one. This replaces a depth limit.
- **Small work skips layers.** Bug, debt, dependency and tooling specs may name
  a top design as their parent directly.
- **Specs gain a `Parent:` line** in the status block (spec 001 section 10 field
  set), alongside the existing "Derives from" links, which keep pointing at
  research and ADRs.
- **Decisions sit where they belong.** Product decisions and uncertain large
  technical choices (section 3) are recorded in the upper designs; lower
  designs and specs are agent territory. A spec that would contradict its
  parent is a change to the parent first, made as a reviewed PR (level 2).
  A maintainer's product answer is written into `product-spec.md` (or the
  relevant top design) through a reviewed spec PR that cites the logged
  answer; a technical answer goes into the spec or an ADR. Each is marked with
  its question comment id, and changing marked text without a newer logged
  answer is a review finding. *(author's call)*
- **Enforced in code.** The spec-present gate rejects a spec whose parent does
  not exist or does not list it as a child. A design-tree check (part of the
  same gate module, run in CI) rejects designs with fewer than two children,
  dangling links and cycles.
- **Staleness.** When a design changes, the system walks its descendants and
  files a finding for each spec or design whose content may no longer fit.
  Reflection flags designs with children missing a spec and specs with no
  implementation. *(author's call: findings, not automatic rewrites)*

This document's own children are specs A to G below (F split into F1 and F2); E is expected to become
a sub-design (design stage, console) when it is written. The existing specs
001 to 005 get `Parent: docs/delivery-system-design.md` as part of B.

## 11. Breaking it into specs

Each becomes a spec under `specs/NNN-<slug>/` in the section 10 field set of
spec 001. The maintainer does not approve them individually: this document is
the direction, and the system writes the specs and builds them through the
pipeline, reaching the maintainer only for section 3 questions.

Order *(author's call)*: B first, because until it lands the old gates still
make every scheduler PR wait for the maintainer's `validated` label and stop
on security findings. Until A exists, a question for the maintainer is posted
as an issue comment that @-mentions the maintainer, the 24-hour reminder
likewise, and the existing notify interface logs both (spec 006). B (spec
006) is built by hand in a supervised session, not through the pipeline,
because under the old gates the pipeline would stop on it for the maintainer.
Then A,
and the rest in table order (each depends on the ones before). F is split so
that the AWS account and cap enforcement exist before E hosts the console in
that account. *(author's call: the split)*

| Spec | Name | Covers |
|---|---|---|
| B | Chain without human stops | section 4, section 5, the spec agent, the section 3 classification check (question check), the design hierarchy of section 10 and its gate checks, process-spec, spec 001 and `specs/README.md` amendments, `docs/charter.md` on the sensitive list |
| A | Telegram channel | long-poll service, questions with options, resume-on-reply, reminders |
| C | Agent registry and direct actions | section 6: definition format, triggers, scheduler support, action log, locks enforced in code, action audit; the parameter store (auto and locked, enforced in code) and applying the system-vs-product work ratio in the shortlist (replacing the fixed 2:1); re-triaging abandoned issues, the recovery path for abandonment (until C, they stay open labelled `abandoned`; the maintainer is informed, not asked to act) |
| D | Event store, metrics and reflection | section 7, the three reflection agents, plans as issues: issues filed from a plan are authored by the App and labelled `validated`, so the shortlist works them. Split into the sub-design `docs/designs/metrics-reflection.md`, specs 026, 027 and 028 in that order (ADR 0004) |
| F1 | Delivery-system AWS account and cap | section 8: the delivery-system AWS account, AWS Budgets enforcement, the scheduler's running estimate, daily forecasting |
| E | Design stage and console | the design stage (design tools, visual review, three screen sizes), then the console of section 9, hosted in F1's account; re-evaluating the issues spec 006 parked with `needs-design-stage` and removing the label |
| F2 | Reach beyond GitHub | section 8: credential store and wrappers, funds and first-contact requests, infra health and credential check agents |
| G | Test board and automatic stable promotion | section 5 firmware: HIL tests on the real board, promotion criteria, the bricked-board pause |

The findings filer (spec 001's out-of-scope list calls it "spec 004"; that
number has since been used) belongs with C. *(author's call)* Spec numbers in
spec 001's out-of-scope list (002 shortlist, 003 Telegram, 004 filing agent)
are stale and are corrected as part of B.

## 12. Documents this changes

- `docs/process-spec.md`: section 2 (the maintainer's place is section 3 of
  this document, not "one gate"), section 3 (spec row), 4.5 (ratio becomes a
  parameter), 5 (automation rule, sensitive-path blocking, stable promotion),
  7 (storage). Section 1's piece table gains the charter above it.
- `specs/001-scheduler-core/spec.md`: AC-7 to AC-13, the section 5 table, and
  section 8 rows for spec present, UI design present, automation change,
  ready, scope, sensitive path and fix loop.
- `agents/sensitive-paths.txt`: add `docs/charter.md`, `docs/product-spec.md`,
  `docs/design-tree.md` and this document.
- `specs/README.md`: spec approval wording, the `Parent:` line, and the design hierarchy rules of section 10.
- `docs/product-spec.md` and this document: a children list each.

## 13. Left to the builder

- The event store's technology and schema.
- The agent definition file's exact fields, and how event triggers are wired
  into the scheduler's poll and wake model.
- Whether the Telegram long-poller lives in the scheduler process or a
  companion service.
- How a resumed session is driven in each harness (Claude Code `--resume`,
  pi's session id).
- The console's stack details within "reuse the web app's toolchain", and how
  state is pushed and changes pulled.
- The precise rescue, re-plan and spec-revision bounds.
- Promotion criteria for firmware stable.

## Children

- `specs/001-scheduler-core/spec.md`
- `specs/002-pipeline-smoke-run/spec.md`
- `specs/003-stage-scope-runtime-max/spec.md`
- `specs/004-pi-tool-names/spec.md`
- `specs/005-keep-unpushed-commits/spec.md`
- `specs/006-no-human-stops/spec.md`
- `specs/007-telegram-channel/spec.md`
- `specs/008-agent-registry/spec.md`
- `specs/009-postponed-chain-holds-slot/spec.md`
- `specs/010-approve-esbuild-build/spec.md`
- `specs/011-asking-stage-keeps-its-work/spec.md`
- `docs/designs/metrics-reflection.md`
- `specs/013-quota-planning/spec.md`
- `specs/014-filer-batch-integrity/spec.md`
- `specs/015-chain-keeps-its-work/spec.md`
- `specs/016-fair-slot-scheduling/spec.md`
- `specs/017-read-only-stages-not-told-to-run-tests/spec.md`
- `specs/018-filer-class-labels/spec.md`
- `specs/019-filer-collapses-identical-records/spec.md`
- `specs/020-failure-finding-does-not-wake-its-agent/spec.md`
- `specs/021-stale-spec-text-after-008/spec.md`
- `specs/022-delivery-aws-account/spec.md`
- `specs/023-waiting-claim-is-not-stalled/spec.md`
- `specs/024-rebase-respects-merged-main/spec.md`
- `specs/025-filer-results-and-wakes/spec.md`
- `specs/029-design-stage/spec.md`
- `specs/031-network-failure-in-a-run/spec.md`
