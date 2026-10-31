# 001. Scheduler core and harness adapters

Status: written 2026-10-12 and approved by the maintainer under the process of
the time (spec 006 removed spec approval); implementation plans written
2026-10-12 in [plans/](plans/) (1-core, 2-runs, 3-service), not yet executed; amended by spec 006
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [process-spec](../../docs/process-spec.md) sections 3, 4.3, 5,
6.1 to 6.6; [design-tree](../../docs/design-tree.md) R6 to R9;
[ADR 0001](../../docs/decisions/0001-harness-per-model-vendor.md);
[research 04](../../docs/research/04-orchestration-tooling.md) and
[09](../../docs/research/09-decision-models.md);
[synthesis](../../docs/research/08-synthesis.md) S11 to S16, D1b.

This is the first spec written in the field set it defines (section 10), and
the first entry under the `specs/NNN-feature/` layout it settles.

## 1. Goal

A deterministic scheduler, `tools/scheduler`, that runs the implementation
chain of the lifecycle on the maintainer's laptop with no model in its
coordination loop. It watches GitHub, ranks and claims validated bot-authored
issues that carry a spec on main that passes spec-present, and moves each
through plan, implement, verify, review and merge, starting every agent stage
as its own headless session in Claude Code or pi through one adapter per
harness. Every rule the process spec says must be enforced "in the script, not
in a prompt" is a tested function in this package.

Decisions this spec records, made 2026-10-03 to 2026-10-09:

- Build, not adopt: no tool combines slot-filling on completion, bot-authored
  authority in script, Telegram and two harnesses (04 Tables 1 to 3).
- The scheduler is a long-lived systemd user service that polls GitHub; no
  public endpoint, no GitHub Actions in the loop.
- The pipeline acts on GitHub as a GitHub App, not as the maintainer.
- Claude models run in Claude Code, everything else in pi (ADR 0001).
- One issue holds one concurrency slot for its whole chain.
- A seam for a decision model exists and is unused.

## 2. Out of scope

Each is its own spec; this one defines only the interface it needs.

- Intake: grilling sessions, spec drafting, the design artifacts of a feature
  (section 10 defines what a spec must contain; producing it is intake).
- The shortlist and authority script beyond the stub in section 7 (a later spec).
- The Telegram bot (design spec A). The core emits notifications to an interface.
- The findings queue consumer and filing agent (design spec C). The core appends
  records to the queue.
- The design systems for the web app and the panel, and the `web-ui` and
  `widget` profile skills (their own specs; section 9 defines what a profile
  is).
- Infrastructure `apply`, AWS credentials and budgets (`infra` profile spec).
- Release: deploys and firmware channel publication stay in CI (process-spec
  section 5).
- Measurement storage and dashboards (piece E). The core writes the records
  they will read.
- Running agent stages inside containers. The pi adapter has the hook; the
  container image is a follow-up because pi has no permission system (03 F45).
- Any use of a decision model.

## 3. Acceptance criteria

Numbered so review findings can cite them. "Given" states are set up with the
fake harness and a mocked GitHub API unless marked (real).

**Scheduling**

- AC-1. Given the service is running with one free slot and the shortlist
  returns issues A and B in that order, when a poll completes, then the
  scheduler claims A only, adds the claim label, writes the claim record, and
  starts A's first stage within one poll interval.
- AC-2. Given A holds the only slot and A's chain is not finished, when polls
  continue, then B is not claimed, and no stage of B ever starts.
- AC-3. Given a stage process exits, when the scheduler is between polls,
  then the next stage of that chain starts within 5 seconds without waiting
  for the poll.
- AC-4. Given the laptop was asleep for longer than the poll interval, when
  it wakes, then the next poll runs within one interval and no claim or run
  is duplicated.
- AC-5. Given `slots` is set to 2 in the config, when two issues are
  shortlisted, then both are claimed; when `slots` is 1, only one is.

**Gates (section 8)**

- AC-6. Given an open issue authored by the maintainer with the `validated`
  label added by the maintainer, when shortlisted, then it is eligible; given
  the same issue without `validated`, then it is ignored and no comment is
  posted.
- AC-7. Superseded by spec 006: Given a bot-authored issue whose linked spec is missing from `main`,
  or whose Open decisions section is non-empty, when shortlisted, then the
  issue receives `needs-spec` with a comment naming the missing part and is
  not claimed.
- AC-8. Superseded by spec 006: Given a spec with domain `web-ui` and an empty `design/` directory,
  when shortlisted, then the issue receives `needs-design` and is not claimed.
- AC-9. Superseded by spec 006: Given a plan result of `spec_gap` with questions, when the plan stage
  ends, then the questions are posted as one issue comment, the issue
  receives `needs-clarification`, the claim is released, and no implement
  stage starts.
- AC-10. Superseded by spec 006: Given an implement result whose diff touches a file outside the
  plan's file scope (lockfiles and `schemas/` excepted), when scope is
  checked, then the chain goes to fix with the violation listed; given it
  happens again on the same issue, then the issue receives `needs-human`.
- AC-11. Superseded by spec 006: Given a diff touching a path on the sensitive list, when review is
  started, then it runs with the `security` review profile; given that review
  returns any finding, then the PR is labelled `security-review` and
  `needs-human`, and merge does not run even if a later review approves.
- AC-12. Superseded by spec 006: Given an issue whose spec changes `tools/scheduler/` or `agents/`
  and whose `validated` label was added by the App bot, when shortlisted,
  then it is ignored; given the label was added by the maintainer, then it is
  eligible.
- AC-13. Superseded by spec 006: Given review returns `changes_requested` for the third time on one
  issue, when the result is processed, then the issue receives `needs-human`
  and no fix stage starts.
- AC-14. Given a PR whose required checks are not all green on the head SHA,
  when verify runs, then review does not start; given a check failed, then a
  fix stage starts with the failing check's log excerpt as input; given
  checks are pending, then the chain waits and re-polls.
- AC-15. Given a claimed issue with no run in flight and no commit, comment
  or label change for 2 hours, when a poll completes, then the claim is
  released, uncommitted changes in its worktree are saved as a patch in the
  state directory, and a comment on the issue says so. *(Amended by spec
  015 section 4: a claim retrying through a transient network outage counts
  as active.)*
- AC-16. Given `main` has moved since a chain's worktree was created, when
  the next stage starts, then the worktree is rebased first; given the rebase
  conflicts, then the chain goes to fix with the conflict as input.
- AC-17. Given the scheduler's own checkout is behind `origin/main`, when a
  poll starts, then it fast-forwards and, if `tools/scheduler/` changed,
  restarts itself after the current stages finish.

**Stages and adapters**

- AC-18. Given a stage definition with `harness: claude`, when the stage
  starts, then the command line contains print mode, stream JSON output, the
  configured model, `--max-turns` and `--max-budget-usd` from the bounds,
  the session id chosen by the scheduler, and a permission mode that never
  prompts; the prompt names the result file path.
- AC-19. Given a stage definition with `harness: pi`, when the stage starts,
  then the command line selects JSON mode, the configured `provider/model`,
  the scheduler's session id and non-interactive project approval; the
  process is wrapped in a timeout and killed with its process group on
  expiry.
- AC-20. Given a pi run whose event stream ends with an assistant message in
  `error` or `aborted` state, when the process exits 0, then the run is
  recorded as failed (03 F8, F51).
- AC-21. Given a Claude run that ends with a result object carrying
  `is_error` or a non-zero exit, or a `stream-json` init event with non-empty
  `plugin_errors` or `mcp_server_errors`, then the run is recorded as failed
  with the reason.
- AC-22. Given a stage that exits without writing its result file, or writes
  one that fails schema validation, then the run is recorded as failed with
  `result: invalid` and the validation errors.
- AC-23. Given a run that hits `timeout`, when the process is killed, then no
  child process of it survives 30 seconds later (checked by process group).
- AC-24. Given any completed run, then a usage record exists with outcome,
  harness, model, cost (null where the harness reports none), input, output,
  cache-read and cache-write tokens, turns, tool calls, wall seconds, start
  and end timestamps, issue, stage, attempt, and the path of the raw event
  stream.
- AC-25. Given a Claude stage fails with API error status 429 and cost at or
  below `retry_cost_limit`, when the stage definition names a `fallback`,
  then it is retried once on the fallback with a new session; given the
  stage is tagged `tier: strong`, then it is not retried on a weaker model
  but postponed, and the chain waits with the claim held. (Amended by spec
  013 and [ADR 0003](../../docs/decisions/0003-opus-fallback-on-model-limit.md):
  the wait ends at the limit's reset, and a strong-tier stage whose own
  Claude model alone is limited may run on the next-best Claude model.)
- AC-26. Given a stage definition with `profile: web-ui`, when the stage
  starts, then the profile's skills directory is made available to the
  session (as `.claude/skills` or `.agents/skills` in the worktree, per
  harness), its instructions are appended to the prompt, and its tool
  allowlist is passed.

**Records and notifications**

- AC-27. Given any gate failure or escalation, then exactly one call to the
  notification interface is made with the issue number, the gate, and the
  label applied; identical notifications are rate-limited to one per 4 hours.
- AC-28. Given an agent stage writes finding records, when the stage ends,
  then each record is appended to the findings queue file with issue, stage,
  run id and timestamp, validated against the finding schema; invalid records
  are kept in a `rejected/` directory and reported, never dropped silently.
- AC-29. (real) Given the service is started against this repository with a
  test issue created through the App, when one full chain runs with the real
  harnesses on a trivial spec, then the PR merges, the issue closes, and the
  records in AC-24 exist for every stage. Done once by hand and logged in
  `dev-logs/`.

**Process hygiene**

- AC-30. Given the service starts, then every stage runs in a transient
  systemd scope with `MemoryMax=50%`, `OOMPolicy=continue` and
  `KillMode=control-group`, and a sleep inhibitor is held while any stage is
  in flight.
- AC-31. Given a stage is in flight, when the scheduler receives SIGTERM,
  then it stops polling, lets in-flight stages finish up to their timeout,
  writes a `stopped` trailer to its log, and exits; on the next start, claims
  with no live run are handled by AC-15.

## 4. Architecture

```
GitHub (issues, PRs, checks)  <-- App token -->  scheduler (systemd user service)
                                                    |  poll loop (30-60 s) + wake on stage exit
                                                    |  shortlist -> gates -> claim -> chain
                                                    |
                                   +----------------+----------------+
                                   |                                 |
                            adapter: claude                    adapter: pi
                            claude -p ... (stream-json)        pi --mode json ...
                                   |                                 |
                            worktree per issue           worktree per issue
                                                    |
                           state dir: claims, runs, usage, events, findings queue, patches
                           notify interface (log; Telegram in spec 003)
                           decide interface (/v1/systemone; unused)
```

Modules in `tools/scheduler/src/`, each with one purpose and its own tests:

| Module | Does | Depends on |
|---|---|---|
| `github/` | App auth (JWT, installation token, refresh), REST and GraphQL calls with full pagination and completeness assertion (process-spec 6.4) | network |
| `shortlist/` | Builds the ranked list; v0 stub described in section 7 | `github/` |
| `gates/` | Pure functions, one per row of section 8 | spec parsing, diff listing |
| `chain/` | The state machine per issue: stage order, transitions, fix-loop counter, outcomes | `gates/`, `stages/` |
| `stages/` | Loads stage definitions, renders prompts, validates result files against schemas | `profiles/` |
| `profiles/` | Resolves a profile to skills dir, instructions, tool allowlist, credentials hook | filesystem |
| `adapters/` | `claude`, `pi`, `fake`; command construction, event parsing, success judgement, usage extraction | process spawn |
| `runner/` | Spawns a stage: worktree, systemd scope, timeout, process group kill, result collection | `adapters/` |
| `state/` | Claims, runs, usage records, patches, findings queue; file layout in section 11 | filesystem |
| `notify/` | Interface plus log implementation and rate limiting | |
| `decide/` | Interface plus a client for `/v1/systemone`; no caller in v0 | network |
| `service/` | Poll loop, wake-ups, self-update, signals, sleep inhibitor | everything |

## 5. The chain

One state machine per claimed issue. States and transitions are code; the
table is the specification.

| From | Event | To |
|---|---|---|
| claimed | start | plan |
| plan | `ready` | implement |
| Superseded by spec 006: plan | `spec_gap` | released, `needs-clarification` |
| Superseded by spec 006: plan | failed | retry once, then released, `needs-human` |
| implement | result valid, scope ok | verify |
| Superseded by spec 006: implement | scope violation | fix (violation as input); second time `needs-human` |
| Superseded by spec 006: implement | failed | retry once, then `needs-human` |
| verify | all required checks green | review |
| verify | a check failed | fix (log excerpt as input) |
| verify | pending | verify (wait, re-poll) |
| review | `approve`, no security finding | merge |
| review | `changes_requested`, fixes < 2 | fix |
| Superseded by spec 006: review | `changes_requested`, fixes = 2 | `needs-human` |
| Superseded by spec 006: review | `escalate`, or security finding | `needs-human` |
| fix | result valid | verify |
| merge | merged | done: claim released, issue closed by the PR, worktree removed |
| merge | not mergeable | fix (rebase/conflict as input) |
| Superseded by spec 006: any | bounds hit, liveness expired | released or `needs-human` per the row above |

Stage order and the fix bound are configuration of the chain module, not of
stage definitions, so a prompt cannot change them.

## 6. Stages

Two kinds. An **agent stage** is one headless session, fresh context, in the
issue's worktree, that ends by writing a JSON result to the path the
scheduler names. A **script stage** is deterministic code: `verify` waits on
the PR's checks; `merge` squash-merges through the API.

Agent stage definitions live in `agents/stages/<name>.md`:

```yaml
---
name: review
kind: agent
harness: claude            # claude | pi
model: claude-fable-5-1    # or provider/model for pi
fallback: claude-opus-5-5  # optional; never used for tier: strong
tier: strong               # strong | standard
effort: high
bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }
permission: no-prompt      # the harness's "nobody will answer" posture
worktree: issue            # issue | fresh
profile: from-issue        # from-issue | <name> | none
input: review-input        # schema names under schemas/scheduler/
output: review-result
---
Prompt body with placeholders: {{issue}}, {{spec}}, {{plan}}, {{pr}},
{{ci}}, {{findings}}, {{result_path}}, {{profile_instructions}}.
```

v0 stage set and result schemas:

| Stage | Tier | Result (validated) |
|---|---|---|
| plan | strong | `{ verdict: ready \| spec_gap, tasks: [{id, description, files[]}], questions?: [], findings?: [] }` |
| implement | standard | `{ pr_number, head_sha, tasks_done: [id], findings?: [] }` |
| review | strong | `{ verdict: approve \| changes_requested \| escalate, findings_on_pr: [{criterion, file, line, scenario}], declined_to_judge: [], findings?: [] }` |
| fix | standard | `{ head_sha, addressed: [index], findings?: [] }` |

Rules:

- Review and plan always run in fresh sessions on the strong tier; implement
  and fix on the standard tier, which may be an OpenAI model in pi where the
  profile allows it.
- A review finding must cite an acceptance criterion number or a repo rule
  and give a concrete failure scenario; style nits are rejected by schema
  (free-text findings without a criterion fail validation).
- `findings` on any result are side-channel records for the findings queue
  (process-spec 4.2), never a reason to deviate from the spec.

## 7. Shortlist stub

> Superseded in part by [008-agent-registry](../008-agent-registry/spec.md)
> AC-14: the ranking by the 2:1 feature-to-debt ratio of process-spec 4.5 is
> replaced by the `system_work_share` parameter of the delivery-system design
> section 9 (a maintainer priority label first, then the preferred kind of
> work by share, then oldest first). The eligibility rules, the pagination
> and the count assertion below still apply.

Until spec 002, the shortlist is: open issues, label `validated` present,
author is the App bot or the `validated` label event's actor is the
maintainer, not already claimed, not labelled `needs-*` or `blocked`, with
all gates in section 8 that apply before claiming. Ranking: a maintainer
priority label first, then the 2:1 feature-to-debt ratio of process-spec 4.5
by change-class label, then oldest first. Listing uses full pagination and
asserts the count against the server total (process-spec 6.4).

## 8. Gates

All are pure functions with tests; each failure maps to one label and one
notification.

| Gate | When | Check | On failure |
|---|---|---|---|
| Authority | shortlist | author is the App, or `validated` set by the maintainer | ignored |
| Validated | shortlist | `validated` present | ignored |
| Superseded by spec 006: Spec present | shortlist | linked `specs/NNN-*/spec.md` on `main` has every required section (section 10) and empty Open decisions | `needs-spec` |
| Superseded by spec 006: UI design present | shortlist | domain `web-ui` or `widget` → `design/` has a story or token prototype and a PNG per screen named in the spec | `needs-design` |
| Superseded by spec 006: Automation change | shortlist | spec touches `tools/scheduler/` or `agents/` → `validated` set by the maintainer | ignored |
| Superseded by spec 006: Ready | plan result | `ready` | `needs-clarification`, released |
| Superseded by spec 006: Scope | implement, fix | diff ⊆ plan file scope ∪ lockfiles ∪ `schemas/`; sensitive paths only if the spec lists them | fix; then `needs-human` |
| Superseded by spec 006: Sensitive path | before review | touched path matches the list → `security` review profile; any finding blocks | `needs-human`, `security-review` |
| Verify | before review, merge | required checks green on head SHA; HIL if `firmware/` changed; mergeable | fix or wait |
| Superseded by spec 006: Fix loop | each `changes_requested` | fixes ≤ 2 | `needs-human` |
| Bounds | every run | timeout, turns, cost; stream shows no error; result validates | failed |
| Liveness | every poll | claim with no run and no activity for 2 h | released, patch saved |
| Freshness | before each stage | worktree on current `main`; scheduler at `origin/main` | rebase; self-update |

The sensitive list is a file, `agents/sensitive-paths.txt`, with globs for
auth, the WASM sandbox host, provisioning, the relay, `tools/scheduler/`,
`agents/`, `.github/`.

## 9. Profiles

A profile is a domain package attached to a stage run: `agents/profiles/
<name>/` with `profile.yaml` (tool allowlist, credential hook, review
criteria file), `instructions.md` (appended to the prompt), and `skills/`
(Agent Skills format, readable by both harnesses). The plan stage classifies
the issue's domain into its result, validated against the profile list;
implement, fix and review use that profile. Review for a domain uses the
same profile as implement, so UI review judges against the design artifacts
and the UX practices in the skill.

v0 profile names: `backend` (default), `web-ui`, `widget`, `firmware`,
`infra`, plus `security` for review only. This spec ships the mechanism and
the `backend` and `security` profiles with minimal content; the others are
filled by their own specs.

## 10. Spec field set

Required sections of `specs/NNN-<slug>/spec.md`, checked by the Spec present
gate:

1. Status line, class and domain, derives-from links.
2. Goal.
3. Out of scope.
4. Acceptance criteria, numbered `AC-n`, Given/When/Then.
5. Interfaces and files.
6. Verification: the end-to-end check, including screenshot, golden-pixel or
   HIL steps where the domain needs them.
7. UI design, required when domain is `web-ui` or `widget`, otherwise absent:
   flow diagram; one rendered artifact per screen and state as a catalogue
   story or, for components that do not exist yet, a token prototype; the
   component mapping; interaction notes. Artifacts live in `design/` beside
   the spec with their rendered PNGs.
8. Open decisions, which must be empty for the spec to be eligible.

`specs/README.md` is updated to this layout. Plans are not committed files:
the plan stage's result is stored in the state directory and posted as an
issue comment.

## 11. State directory

`~/.local/state/panelator-scheduler/`:

```
claims/<issue>.json        issue, slot, chain state, fixes, worktree, started
runs/<run-id>/             command.txt, events.jsonl, stderr.log, result.json, usage.json
usage/<run-id>.json        the AC-24 record (180-day retention)
patches/<issue>-<ts>.patch uncommitted work saved on release
findings/queue.jsonl       appended by AC-28; consumed by spec 004
findings/rejected/
token.json                 current installation token and expiry
log/                       service log with `tick` and `stopped` trailers
```

GitHub holds the visible state: the claim label (`in-progress`, applied and
removed only by the scheduler), `needs-*` labels, plan and
release comments, PRs. The state directory holds what GitHub cannot: run
records and patches. If the two disagree, GitHub wins and the claim is
treated as stale.

## 12. GitHub App

Permissions: issues (write), pull requests (write), contents (write), checks
and actions (read), metadata (read), repository security advisories (write)
for spec 004. Installation tokens expire after an hour, so the scheduler
refreshes `token.json` every 50 minutes, and stages get a `gh` wrapper on
`PATH` plus a git credential helper that read it; agents never handle
tokens. Everything the pipeline files appears as the App's bot user, which
is what the Authority gate keys on.

## 13. Adapters

Common interface: `run(spec: StageRun): Promise<RunResult>` where `StageRun`
is prompt, model, bounds, worktree, session id, result path, profile; and
`RunResult` is outcome (`ok | failed | timeout | bounds`), reason, usage
(AC-24 fields), final text, event stream path. Each adapter owns command
construction and event parsing; the runner owns the process.

- **claude**: `claude -p` with `--output-format stream-json`, `--verbose`,
  `--model`, `--max-turns`, `--max-budget-usd`, `--session-id`, the
  no-prompt permission posture, and `--fallback-model` where set. Success
  requires a final result object without error and an exit code of 0; the
  init event's plugin and MCP error lists must be empty. Cost and per-model
  usage come from the result object; they are client-side estimates (03
  F34). `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is set to the stage timeout.
  Not `--bare` (ADR 0001).
- **pi**: `pi --mode json` with `--model provider/id`, `--session-id`,
  non-interactive trust approval, and `-e` for any profile extension.
  Success is judged from the event stream (`agent_end` without error or
  abort, 03 F8); cost is summed from the stream's cumulative usage (03 F33).
  pi has no bounds, so the runner's timeout is the only wall-clock bound and
  turns are counted from events, with the process killed when `max_turns` is
  exceeded. The runner reads stdout continuously to avoid the documented
  back-pressure stall (03 F9). Container isolation is a hook on this adapter,
  off in v0.
- **fake**: replays a recorded event stream and writes a canned result file;
  used by every test that does not need a real model.

Cross-harness fallback: a standard-tier stage may name a pi model as
`fallback`; a strong-tier stage may not (AC-25).

## 14. Service

A systemd user service, `panelator-scheduler.service`, `Restart=on-failure`,
`WantedBy=default.target`. Each stage runs in a transient scope created with
`systemd-run --user --scope` carrying `MemoryMax=50%`, `OOMPolicy=continue`,
`KillMode=control-group`; `systemd-inhibit --what=sleep:idle` wraps every
in-flight period. Before each poll the checkout fast-forwards `main`; if
`tools/scheduler/` changed, the service restarts after in-flight stages
finish. `CI=true` is set for every stage to defeat watch modes. Poll
interval 45 s by default, `slots` 1 by default, both in
`agents/scheduler.yaml`. The config file is the only thing not fetched from
`main` at runtime; it is committed and read at start.

## 15. Interfaces and files

- `tools/scheduler/` (package `@panelator/scheduler`): `src/` modules of
  section 4, `bin/scheduler`, `systemd/*.service`, `test/` with recorded
  event streams under `test/fixtures/`.
- `agents/scheduler.yaml`, `agents/stages/*.md`, `agents/profiles/*/`,
  `agents/sensitive-paths.txt`.
- `schemas/scheduler/*.json`: stage inputs and results, usage record,
  finding record, claim record.
- `specs/README.md`: layout and field set of section 10.
- Notification interface: `notify(event: {issue, gate, label, text})`.
  v0 implementation appends to the service log.
- Decision interface: `decide(state, questions) -> typed answers` over
  `POST /v1/systemone`, with a config entry for the base URL and key, no
  caller.
- Findings queue: append-only JSONL, schema `finding`.

## 16. Verification

- `pnpm test` runs the scheduler's vitest suite: gates, chain state machine,
  adapters against recorded streams (including a pi stream that exits 0 with
  an error state and a Claude stream with plugin errors), schema validation,
  pagination completeness, token refresh, rate-limited notifications.
- A recorded end-to-end test drives a full chain with the fake adapter and a
  mocked GitHub API, asserting the label and comment sequence and the
  records written.
- AC-29 once by hand against the real repo with a trivial issue, result and
  numbers logged in `dev-logs/`.
- The service runs for one week with `slots: 1` on real issues before any
  profile beyond `backend` is enabled; the usage records from that week are
  the first dataset for piece E.

## 17. Testing approach

Test-first per module. Adapters are tested only against fixtures; real
harness invocations are the manual AC-29 run. Gates are pure functions over
plain data (issue, labels with actors, spec text, diff file list), so every
row of section 8 has a table-driven test. The chain is tested as a state
machine with scripted stage outcomes. No test touches the network.

## 18. Open decisions

None.
