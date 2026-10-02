# Research synthesis

Status: complete. Every open item in process-spec section 9.1 appears in
section 2 (settled) or section 3 (open). No new research was done; every
claim cites a file and finding number from `01` to `07` in this directory
(`03 F12` means file `03-harness-evaluation.md`, finding 12; files 02 and 06
number their findings `F1...`, the others `1...`; both are cited as `Fn` here).
Date: 2026-10-02

Inputs: `01-repo-internals.md`, `02-lifecycle-practices.md`,
`03-harness-evaluation.md`, `04-orchestration-tooling.md`,
`05-token-efficiency.md`, `06-measurement.md`,
`07-kari-website-retrospective.md`, then `../process-spec.md`.

Reading note: three input files are marked partial (01, 06) or complete with
named gaps (02, 03, 04, 05, 07). The OpenAI "Harness engineering" post is
unverified throughout (primary returns HTTP 403; 01 F21, F29, F51, F55) and
is cited below only with that tag. The harness hands-on phase has not run
(03 status), so section 2 settles nothing that depends on it.

---

## 1. What others do

Recurring patterns across the seven files. Descriptive; each points to the
findings that support it.

1. **Short guidance map, deep docs; the file is advisory and enforcement is a
   separate mechanism.** Codex says "short and accurate" and splits into
   task-specific files (01 F3); Claude Code targets under 200 lines, says
   imports do not reduce cost, and names hooks as the deterministic
   alternative (01 F4, F5, F6); OpenAI's internal repo moved to a ~100-line
   table of contents [unverified] (01 F21); mature public files point outward
   (Airflow 12 links, next.js 11, Biome 9 into skills) (01 F9). Zed's rule is
   "traps to avoid, not maps to follow" (01 F12). Only Airflow generates and
   validates its file against ground truth (01 F11); one rule in
   anthropics/claude-code names its CI check (01 F14); every other repo read,
   including kari-website, checks nothing (01 F16, F19). kari's file grew 29x,
   was halved once for cost, and regrew within three weeks (01 F17, F18;
   05 F14; 07 F51).

2. **AGENTS.md is the harness-neutral file; CLAUDE.md is a shim.** ruff and
   kari use `CLAUDE.md` = `@AGENTS.md` (01 F9, F20); Claude Code reads
   AGENTS.md natively since v2.1.277 (01 F7); pi, Codex, OpenCode, Goose and
   Hermes all load it (03 F27, F29, F30, F31, F32). Nested per-area files are
   common and small (01 F9, F10, F11, F12).

3. **Interview, write a spec, start a fresh context; spec fields converge;
   nobody measures fidelity.** Grilling's frontier rounds with a confirmation
   gate (02 F1, F2), brainstorming's hard gate between design, spec and plan
   (02 F3; 01 F22), Claude's "interview me ... write SPEC.md ... fresh
   session" (02 F7; 01 F31). Templates converge on out-of-scope, numbered
   testable criteria, named files and interfaces, and an end-to-end
   verification step (01 F23, F26, F27, F31; 02 F4, F6, F15). No source
   publishes outcome data for any spec method (01 F32; 02 F5, F9).

4. **Plans carry exact values so a cheaper executor transcribes.** Files with
   line ranges, Interfaces consumed/produced, `Run:`/`Expected:` lines, "No
   Placeholders" (01 F23; 02 F15); kari's plan brief "name real files, real
   functions, real test cases" (02 F8); both SDD and executing-plans say a
   fully specified plan runs on a mid-tier model (02 F12, F13).

5. **Separate the grader from the worker; tell the reviewer what not to
   report.** Fresh-context reviewer subagents (02 F10, F14, F16), a separate
   evaluator model in `/goal` (02 F17), Anthropic's finding that self-grading
   "confidently prais[es]" mediocre work (02 F19), kari's fresh-session
   validator and adversarial review brief (02 F22, F43), Biome's fresh
   subagent given only scope and requirements (01 F13). Reviewers are told
   "only P0/P1" (02 F27), "no style nits" (02 F22), "flag only gaps that affect
   correctness" (02 F16), with a "Declined to judge" list (02 F14).

6. **Bound the fix loop; escalate by changing something, never by repeating;
   one fix wave at the end.** SDD: five rounds, resume for three, fresh
   implementer one tier up at four, adjudicate at the cap, one fixer for all
   final-review findings because a fix wave once "cost more than all its tasks
   combined" (02 F10, F13); kari: two surviving cycles → plan agent → human
   (02 F21; 05 F28); Anthropic: two failed corrections → clear context and
   re-prompt (02 F16); `/goal` stops after several no-tool turns (02 F17).

7. **Deterministic shell around a probabilistic agent; state in GitHub;
   positive evidence before destruction; every cap visible.** uv gates each
   stage on schema-validated JSON (04 F58); toolhive inserts a shell "Hard
   gate" between agent phases (04 F59); gh-aw makes agents read-only and
   applies writes in validated jobs (04 F63); Bernstein keeps "no model in the
   coordination loop" (04 F68). kari moved listing, liveness, fallback and
   ranking from prose into scripts after incidents (07 F29, F30, F50, F57),
   made "a failing probe count as life" (07 F54) and printed `*_omitted`
   counts after a silent truncation went unnoticed for three days (07 F29,
   F55). Recovery relies on statelessness: "state lives in GitHub, so the next
   due tick recovers" (07 F52).

8. **Polling a tracker into fixed concurrency slots is the dominant
   open-source shape; hosted products schedule by wall clock.** Symphony's
   `available_slots`, Baton's `max_concurrent`, Multica's 20/6 caps, kari's
   `MAX_IN_FLIGHT` (04 F1, F6, F65, F66, F67). Routines (1 h minimum), Desktop
   tasks, Codex automations, Copilot automations, Jules tasks and Actions
   `schedule` (5-minute floor, load delays, 60-day auto-disable on public
   repos) are all clock-driven (04 F28, F29, F32, F38, F43, F49, F55). Only
   openclaw's `workflow_run` gate and Multica's queue-while-offline behave
   like start-on-completion (04 F62, F67).

9. **Agent definitions are Markdown with YAML frontmatter.** kari (04 F3),
   Baton `WORKFLOW.md` (04 F66), gh-aw compiled to `.lock.yml` (04 F63),
   Claude Desktop task `SKILL.md` (04 F32), uv's prompt files (04 F58),
   OpenCode agents (03 F30).

10. **Write authority is scoped by identity and label; vendors gate on who
    asked, never on whether the ask is right.** Write-access checks, bot
    allow-lists, hidden-character stripping, requester-cannot-approve
    (02 F26, F46); dedicated GitHub App identities and per-run tokens
    (04 F58, F59, F60); gh-aw's per-output caps (04 F63); kari's `agent/*` +
    `agent-pr` dual signal because credentials were shared (02 F45; 07 F45,
    F48). No vendor validates an issue's premise (02 F47); kari's validator
    exists only as prose (02 F43; 07 F49).

11. **Model tiering by stage: strong on judgment, cheap on implementation.**
    kari's validate/plan/review on fable and implement/fix on opus, with
    "never downgrade" the judgment tier (05 F28; 07 F5); SDD's "least
    powerful model that can handle each role" with the caveat "turn count
    beats token price" (02 F12); Claude Code `opusplan` and per-subagent
    `model:` (05 F29); Anthropic's Opus-lead/Sonnet-subagent result (05 F31);
    Aider's architect/editor benchmark (05 F30); toolhive's Sonnet triage /
    Opus test-writing in separate steps (04 F59). Codex routes effort, not
    model (05 F29).

12. **The prompt cache is the architecture; spend is output and cache writes;
    subagents isolate context but cost tokens.** Stable content first, model
    and effort fixed at session top, anything after a change re-read (05 F18,
    F21, F22); kari reached 96.5% cache reads without trying, and its fable
    spend was dominated by output and writes, not input (05 F6); subagents
    "count toward the same usage limits" and multi-agent runs use ~15x the
    tokens of chat (05 F26); always-loaded material (guidance file, plugin
    injection, MCP schemas) is trimmed or deferred (05 F13, F15, F16, F17).

13. **Cost is a per-run, client-side estimate; caps are per run; vendor
    usage APIs are closed to individual accounts.** Every harness prices from
    a table (03 F33, F34, F35, F36); Claude Code says so explicitly and its
    `usage` excludes subagents while `total_cost_usd` includes them (05 F20;
    06 F43); only Claude Code and Goose bound a run from the CLI (03 F12,
    F18); fleet-level caps exist only as gh-aw's daily credits (04 F63) and
    kari's $2 retry ceiling (05 F9); Anthropic's and OpenAI's usage APIs and
    Copilot metrics need an organisation (06 F9, F10, F11, F45).

14. **Deployed systems drift toward spend control; fallback never covers
    quota.** Nine cadence edits in 23 days, every downward step citing
    subscription spend, every upward step time-boxed to burn an expiring
    allowance (02 F21; 05 F4; 07 F3); `--fallback-model` covers overload only
    and "never once" engaged on quota until a 429 retry was scripted (03 F61;
    04 F8; 05 F8, F9; 07 F17); the judgment-tier limit wedged the fleet for
    ~20 h because the policy forbade downgrading (07 F19).

15. **HIL CI: build hosted, flash and assert on a self-hosted runner labelled
    by board, serial-regex assertions, JUnit, timeouts, explicit flake
    handling.** ESP-IDF pytest-embedded with environment markers (02 F31),
    esp-dsp's tagged GitLab jobs (02 F32), Golioth's `[is_active,
    has_<board>]` labels with 600 s / 30 min timeouts and `erase_flash`
    cleanup (02 F33), Zephyr's hardware map, fixtures and quarantine list
    (02 F34).

16. **Firmware promotion is calendar-driven and human-run; service canaries
    are metric-thresholded with automatic abort.** HA, ESPHome, Tasmota, WLED
    promote on a fixed day by a maintainer, none on a metric (02 F38, F39,
    F40, F41, F42); Argo Rollouts and Flagger abort on `failureLimit` /
    `threshold` and pause for a human on an inconclusive result (02 F36, F37;
    06 F31).

17. **Autonomy is gated by risk class decided in advance plus green checks,
    with per-item demotion signals; no deployed scheme promotes a class on
    measured history.** Renovate's `lockFileMaintenance` → `devDependencies`
    → patch/minor graduation (06 F29), Dependabot's `update-type` gate
    (06 F30), Prow/Mergify label rules (06 F32), jade's per-unit grades with
    hard blockers ("a retried unit never auto-merges") (06 F34). AWS's
    trust-score ladder is a reference design with no data (06 F33); the
    absence is the finding (06 F36). kari moved one class *down* the ladder
    after pre-1.0 minors broke the build under green CI (07 F23; 06 F30).

18. **Delivery outcomes over activity; throughput read with instability;
    rejections categorised before counting.** DORA's five metrics and its
    "cost per accepted change and code rework rates" recommendation (06 F1,
    F4); AI adoption raises both throughput and instability (06 F2); vendor
    dashboards report activity and GitHub calls its own numbers "directional"
    (06 F7, F8, F10); the agent-PR studies split non-merge into abandonment,
    duplicates, CI failures, unwanted features (06 F15, F16, F50); token
    volume is a vanity metric and a Goodhart target (06 F47, F48).

19. **The laptop as runner: every incident got a mechanical backstop.** Drift,
    suspend, stale clone, orphaned stacks, the 600 s kill, OOM, watch mode,
    fallback (07 F8 to F17) each became a `dispatch.sh` or unit-file change
    quoting the incident (04 F13, F14, F15; 07 F50). dyad schedules Claude on a
    self-hosted macOS runner (04 F60); Cursor and Copilot offer "your machine
    executes, vendor hosts the loop" (04 F45, F52); GitHub warns self-hosted
    runners "should almost never be used for public repositories" (04 F57).

20. **Chat channels are outbound-only transports; GitHub is written first.**
    Telegram long polling with 24 h retention, Slack Socket Mode, Discord
    Gateway (04 F77, F78, F82); kari writes every reply onto the issue before
    anything else: "Telegram is transport, nothing more" (07 F58; 02 F23);
    harness-native channels either open a cloud session (Claude in Slack,
    Cursor) or push into an already-running local session (Claude Code
    Channels, OpenClaw, Multica) (04 F79, F80, F81, F83, F84); only Hermes
    bundles a Telegram gateway with its own cron (03 F32).

21. **Per-language enforcement stacks are layered; no single tool spans
    languages; generated artifacts are regenerated in CI.** TS: graph tool +
    dead-code tool + style linter (01 F33 to F37); Rust: workspace lints +
    clippy + cargo-deny + machete/udeps (01 F38 to F41); C/IDF: clang-tidy
    (esp-clang "still under development") + IWYU + kconfcheck + component
    `REQUIRES` (01 F42 to F46). ruff fails CI on regenerated diff, Biome
    auto-commits it (01 F48); schemars output is not stable across its own
    versions (01 F47). Only OpenAI's internal repo describes structural tests
    on code itself [unverified] (01 F51).

22. **Machinery grows fastest at the start and filings outpace closes.**
    66 to 77% of agent merges in kari's first three days were machinery, near
    zero by September; the open backlog is still 54% `tooling`; a merged PR
    spawned two to three issues while closing one (07 F35, F45, F46; 02 F44;
    05 F12).

23. **Headless contracts are JSONL event streams with weak exit codes and
    resumable sessions.** All six harnesses emit newline-delimited events
    (03 F7, F9, F11, F15, F17, F18, F19); exit status is unreliable in four of
    them (03 F8, F16, F17, F51); every candidate resumes by id, pi and Claude
    Code accept caller-chosen ids (03 F39 to F44); unattended runs need an
    explicit "nobody will answer" switch (03 F46, F47, F48, F50).

---

## 2. What the evidence settles

Open items from process-spec section 9.1 that the research answers outright.
Each is an ADR candidate. Where only part of an item is settled, the rest is
cross-referenced to section 3.

### Piece B

**S1. Root guidance file is `AGENTS.md`; `CLAUDE.md` is a one-line `@AGENTS.md`
shim.** Every candidate harness loads AGENTS.md (03 F27, F29, F30, F31, F32);
Claude Code reads it natively from v2.1.277 and documents the shim as the
portable fallback (01 F7); ruff and kari already run this way (01 F9, F20).
Constraints inherited: Codex's 32 KiB cap on the concatenation (01 F2;
05 F16), Claude Code's under-200-lines target (01 F4). Rest of item B3 (how it
is kept current, budget) is open: section 3, B3.

**S2. Guidance content is advisory; any rule that must hold is a hook, script
or CI check; detail is routed, not imported.** Anthropic states guidance is
"context, not enforced configuration" and names PreToolUse hooks as the
deterministic alternative (01 F5); imports load at launch and do not reduce
cost (01 F4), so kari's trigger-line pattern ("if you are about to do X, read
Y FIRST") is the cost-neutral way to point at detail (01 F18); Zed's criteria
for admitting a rule (non-obvious, repeatedly hit, actionable) and Codex's
"same mistake twice" trigger define what belongs in prose (01 F3, F12); kari's
record shows prompt-only rules were the recurring failure class and each fix
moved the rule into a script (07 F49, F50). This extends the spec's existing
4.3/6.4 principle from the shortlist to the guidance file.

**S3. Spec minimum field set.** Goal, explicit out-of-scope, numbered testable
acceptance criteria, named files and interfaces, and an end-to-end
verification step are demanded by every template read (01 F23, F26, F27, F31;
02 F4, F7, F15). Notation and directory layout remain open: section 3, B1, B2.

**S4. ADR location and numbering.** `docs/decisions/NNNN-title-with-dashes.md`,
sequential, with explicit supersede links (01 F28); the spec already names
`docs/decisions/` (process-spec 4.2). Field set open: section 3, B4.

### Piece C

**S5. The review agent is a fresh session that sees the diff and the spec,
reports only correctness and spec gaps, and lists what it declined to judge.**
Supported by every source that discusses review (02 F10, F14, F16, F17, F19,
F22, F43; 01 F13, F31). kari's reviewer contract ("CLEAN or a numbered list;
every finding needs a concrete failure scenario or a violated repo rule; no
style nits") is a deployed instance with findings credited in merge commits
(02 F22; 07 F59).

**S6. The fix loop is bounded and escalation changes something (model tier,
planner, fresh context), never re-sends the same input; the final review gets
one fix wave.** Three independent designs agree on the shape (02 F10, F13,
F16, F21; 05 F28). The numbers are open: section 3, C4.

**S7. The review gate must be mechanical.** No vendor reviewer blocks a merge
by itself (02 F24, F25, F27, F29); kari's gate was a label checked by a prompt
against branch protection requiring zero reviews, so a tick that skipped it
could merge any green PR (07 F48, F49). Which mechanism (required status
check, bot approval under a required-review rule, orchestrator script) is
open: section 3, C1.

**S8. Issue authority needs a distinct bot identity; precedent is a GitHub
App.** Process-spec 4.3 keys on bot authorship, but the predecessor filed all
627 issues under the maintainer's account and could only mark provenance with
a self-applied label (07 F45; 02 F45). Every production pipeline read commits
and writes as an App identity with per-run tokens (04 F58, F59, F60); vendors
gate on actor identity (02 F46). No tool implements "only work issues authored
by the bot" (04 F58, F59, F63; 04 open question 4), so the shortlist filter is
ours to write, and it is only possible once the App exists.

**S9. HIL CI shape.** Build on a hosted runner, flash and assert on the
self-hosted runner labelled per board, serial-regex assertions, JUnit output,
per-test and per-job timeouts, an explicit flake policy and a post-test erase
(02 F31, F32, F33, F34). Parameters open: section 3, C1.

**S10. Grilling output is written to GitHub first; Telegram is transport.**
kari's rule and its stated reason ("Note for a human" lines nobody reads in
time) (07 F58; 02 F23); the spec's 4.1 and 6.3 already say this. Bot
implementation and session handling open: section 3, C5 and D4.

### Piece D

**S11. Claude Code and Codex CLI are not the fleet harness.** Claude Code is
Claude-only and not open source (03 F2, F21); Codex speaks the Responses API
only and cannot call Anthropic models, which the spec's own hands-on
comparison requires (03 F23). Survivors of the two hard requirements: pi,
OpenCode, Goose, Hermes (03 F7, F17, F18, F19, F20, F24, F25, F26). Which
survivor, and whether Claude Code remains as a Claude-only worker, is open
pending the hands-on phase: section 3, D1.

**S12. The dispatcher consumes the event stream and owns run bounds.** Exit
status is unreliable in pi (exit 0 on failed response and on exhausted output
budget), Codex and OpenCode (undocumented), Goose (not found) (03 F8, F16, F17,
F18, F51); only Claude Code and Goose bound turns or dollars from the CLI
(03 F10, F12, F16, F18). Per-message cost in pi's stream and Claude's result
object make a supervisor feasible (03 F13, F33). This operationalises
process-spec 6.4's "an error they cannot ignore".

**S13. Agent definitions are Markdown files with YAML frontmatter, one per
role, in the repository.** Independent convergence (04 F3, F32, F58, F63, F66;
03 F30). Field set open: section 3, D2.

**S14. Telegram transport: long polling from the laptop, no public endpoint,
exactly one `getUpdates` consumer per token, 24-hour server-side retention.**
Bot API and grammY documentation (04 F77, F78); the Channels plugin kills
stale pollers for the same reason (04 F79). Confirms process-spec 6.3.
Implementation choice open: section 3, D4.

**S15. Token-efficiency techniques that carry forward unchanged.** Stable
prefix first and model/effort fixed per session (05 F18, F21, F22); trim or
defer always-loaded material (05 F13, F15, F16, F17); minimal startup for
scripted runs (`--bare` or equivalent) (05 F27; 03 F14); CLI tools over MCP
(05 F17; 01 F50); subagents for context isolation with the knowledge that
they do not save tokens (05 F26); judgment on the strong tier (05 F28, F31;
02 F12); fallback-model for overload plus a scripted, cost-capped retry on
429 (05 F8, F9; 03 F61; 04 F8). Which TTL, which models, which bounds: open,
section 3, D5.

**S16. The predecessor's laptop fixes are known and scripted; carry them
forward as one unit.** Transient systemd scope per session with
`MemoryMax=50%` and `OOMPolicy=continue` (07 F13, F15; 04 F14); zram (07 F15);
sleep inhibitor plus host-side power config, "two independent defences"
(07 F9); `--ff-only` self-update before every tick (07 F12; 04 F13); a finite
background-wait ceiling (07 F14; 03 F60); `CI=true` to kill watch mode
(07 F15); a `tick exited` trailer so SIGKILL is distinguishable from running
(04 F15). Residual open failure modes: section 3, D6.

### Piece E

**S17. Measurement principles.** Outcomes, not activity, are success metrics
(06 F4, F8, F48); throughput is always read beside an instability metric
(06 F2); cost per accepted change and rework are endorsed by DORA (06 F4);
merge rate is uninterpretable without rejection categories (06 F15, F50); on
individual subscriptions the harness's client-side estimate is the only cost
source, with its documented undercount/double-count/crash caveats (06 F42,
F43, F44, F45, F53); collection uses list and timeline endpoints with
pagination, never search, whose `total_count` can exceed what is retrievable
(06 F37 to F41). Final set and definitions: section 3, E1.

**S18. The v0 autonomy ladder is risk-class-in-advance plus green checks plus
per-item demotion signals.** No deployed scheme promotes a class of code
change on measured history (06 F36); every deployed ladder picks the class
ahead of time and lets CI plus labels decide (06 F29, F30, F32, F34);
metric-gated promotion with automatic rollback exists only for deployments
(06 F31; 02 F36, F37); firmware stable promotion is human and calendar-driven
everywhere (02 F42). This matches process-spec 5 as written. Thresholds for
earning more autonomy: section 3, E2.

---

## 3. Open questions for the thinking run

The agenda. Grouped by piece; each item names the options the evidence leaves
open and what favours each. Together with section 2 this covers every item in
process-spec 9.1.

### Piece B: repo internals

**B1. `docs/` and `specs/` shape.** Options: (a) flat dated files
`specs/YYYY-MM-DD-<topic>.md` as superpowers does and the spec assumes
(01 F22, F23, F24); (b) one directory per feature `specs/NNN-feature/{spec,
plan,tasks}.md` with numbered FR/SC ids (spec-kit, 01 F26); (c) three-file
requirements/design/tasks sets (Kiro, 01 F27); (d) OpenAI's
`docs/{product-specs,design-docs,exec-plans}` split with a generated section
[unverified] (01 F29). Favours (a): least machinery, already in the spec,
kari's worked instance (01 F24). Favours (b): numbered ids make spec-deviation
findings and spec-churn counts addressable (06 F20, F21); a tasks file is the
plan artifact. Also open: is the plan a committed file or an issue comment?
kari dropped files after retiring superpowers ("the issue plus its planning
pass is the spec") and posted 44 plan comments (01 F25; 07 F47); a committed
plan survives compaction and executor changes (02 F11, F13; 01 F30).

**B2. Spec notation for acceptance criteria.** Given/When/Then with
`[NEEDS CLARIFICATION]` markers and measurable SC (02 F4), EARS "WHEN ... THE
SYSTEM SHALL" (02 F6), or the lighter files/interfaces/out-of-scope/e2e-step
form (02 F7) plus writing-plans' Global Constraints and Review Focus (02 F15).
No fidelity evidence exists for any (02 F9; 01 F32); the spec's deviation and
churn metrics would be the first. Favours GWT/EARS: a review agent can match
findings to numbered criteria. Favours light: Claude's own guidance and lower
authoring cost on Telegram.

**B3. Keeping `AGENTS.md` current, and its budget.** Mechanisms seen: nothing
(01 F16, F19); a written hygiene policy with reviewer-decided additions
(Zed, 01 F12); a retrospective-on-repeat-mistake rule (Codex, 01 F3);
generated sections plus a validator against the real CLI (Airflow, 01 F11);
`/doctor prompt-audit` (01 F6). kari's one-off trim worked and regrowth began
immediately (01 F17, F18; 05 F14). Budget: ~100 lines [unverified] (01 F21),
under 200 lines (01 F4), 32 KiB hard cap (01 F2); five of eleven popular files
exceed 200 lines (01 F9). Sub-questions: a CI line/byte cap (05 open question
6); whether process-spec 5's "automation changes need a human-approved spec"
covers the guidance file; path-scoped `.claude/rules/` (Anthropic-only,
01 F4) versus nested per-directory `AGENTS.md` for `firmware/`, `backend/`,
`web/` (harness-neutral, 01 F9, F12). The test for keeping a rule in prose at
all: kari's "silent, expensive failure modes" (01 F19) or Zed's three criteria
(01 F12).

**B4. ADR field set.** MADR 4.0.0 (front matter, drivers, options, outcome,
consequences, confirmation; no tooling for ≥3.0) versus Nygard's five fields
with adr-tools (01 F28). Favours Nygard: tooling and brevity for Telegram-born
decisions. Favours MADR: "Confirmation" field maps to the spec's demand that
rules be enforced somewhere.

**B5. Tool selection inside the settled enforcement approach.** TypeScript:
dependency-cruiser (graph rules, cycles, orphans, reachability; 01 F35) versus
eslint-plugin-boundaries (element types inside ESLint; limits not documented;
01 F34) versus Biome's per-file `noRestrictedImports`/`noPrivateImports`
(no graph; 01 F37); steiger only under FSD (01 F33); knip orthogonal (01 F36).
Rust: which clippy groups at deny under `[workspace.lints]` (01 F38, F39),
cargo-deny config (01 F40), machete on stable versus udeps on nightly
(01 F41), whether `disallowed_*` lints [unverified lead] replace a boundary
tool (01 F38). C/ESP-IDF: `idf.py clang-check` now despite "under development"
(01 F44), upstream clang-tidy/IWYU on the compile database (01 F42, F43), or
`REQUIRES`/`PRIV_REQUIRES` plus kconfcheck only (01 F45, F46). Schema drift:
fail on regenerated diff (ruff) versus auto-commit (Biome) (01 F48), and how
to survive schemars version changes (01 F47). Structural tests on file size,
dependency direction and naming plus a scheduled garbage-collection agent have
one precedent, unverified (01 F51). An agent-contribution policy for the
public tracker is published by every project read and is not in 9.1 (01 F15,
F57).

### Piece C: feature lifecycle

**C1. Stage mechanics.** Sub-questions the evidence leaves open:

- *Review granularity.* Per-task review inside the worker (SDD, 02 F10)
  versus one review per PR at the gate (kari, 02 F22) versus both. Bears on
  cost (fix-wave anecdote 02 F10; QA rounds $3 to $4 each, 02 F19) and where
  deviation is caught.
- *Rulings versus stop.* SDD records "Ruling: ... what it costs if wrong" and
  never waits on a human (02 F11); kari's worker says "STOP: do not guess at
  product decisions" (02 F22); the spec has one human gate. Options: rulings
  within the spec, stop only on product decisions; stop on any ambiguity;
  rulings always, surfaced for review.
- *Blocking mechanism (from S7).* Required status check posted after review;
  bot approval satisfying a required-review rule as Copilot does (02 F24,
  F29); Prow/Mergify-style label conditions (06 F32); Stop-hook/deterministic
  script (02 F16); orchestrator script before `gh pr merge` (02 F29, F30; 07 F48).
- *Own reviewer versus vendor reviewer.* Vendors are advisory, model-fixed or
  plan-metered, identity-gated and silent on per-review cost (02 F24, F25,
  F27, F28, F46); kari's own reviewer is spec-aware and cheap to tune but
  unscripted (02 F22). Options: own only; vendor as second opinion on
  sensitive paths; vendor only.
- *Reviewer false positives.* Handled by instruction and by letting the fixer
  dismiss with a reasoned comment (02 F16, F22, F27). Open: count dismissals
  as a reviewer-quality metric; who may dismiss a security finding.
- *Validation stage, scripted or prose.* kari's is explicitly "a process
  rule, not a GitHub permission or scripted gate" with no measured effect
  (02 F43; 07 F49; 07 open question 9); no vendor validates premise
  (02 F47). Which parts can be scripted: freshness `git diff` against a
  reviewed SHA, verdict presence, fresh-session requirement, machine-readable
  verdict.
- *Interview bound for grilling.* Five questions by impact × uncertainty
  (02 F4) versus frontier-empty (02 F1) versus one question per message
  (02 F3). Bears on Telegram pacing; the grilling skill's own change log
  reports only rounds-per-session (02 F2).
- *HIL parameters (from S9).* Label scheme, per-test and per-job timeouts
  (600 s / 30 min at Golioth, 1 h at esp-dsp), quarantine versus rerun, and
  whether HIL runs per PR or on merge/schedule as Golioth does (02 F31 to
  F34). The laptop is both agent host and HIL rig (process-spec 6.1).
- *Firmware stable promotion rule.* All four OTA projects promote on a
  calendar by a human (02 F38 to F42). Open: threshold, window, and whether a
  minimum-days-in-beta floor remains when the metric passes.
- *Canary tooling at small scale.* Argo and Flagger assume Kubernetes and a
  metrics provider (02 F36, F37; 06 F31); the backend target is not fixed.
  Options: adopt one; reproduce "N failed checks over interval → abort;
  inconclusive → pause" in deploy scripts.
- *Batching.* kari combined ≤3 mechanical issues per branch at dispatch and
  ≤6 per umbrella at grooming, unmeasured (05 F10, F34); hosted CI minutes
  are free on a public repo, so the remaining benefit is fewer review and fix
  cycles (05 F35).
- *Triage and dedupe.* kari closed 61 issues as duplicates and 23% of
  rejected agent PRs in the public dataset were duplicates (07 F45; 06 F15);
  no source describes the mechanics.

**C2. Label protocol.** Precedents: kari's `automation` (provenance) versus
`tooling` (topic) split, human-only `priority`/`user-feedback`, `needs-human`
with a `Blocks: #N` line, `needs-clarification` that "a human removes",
`in progress` synced by a workflow (02 F45; 07 F6, F42, F44, F48, F49);
Prow/Mergify label conditions (06 F32); gh-aw's `add-labels` max 5 (04 F63).
Recorded failures to design against: `needs-human` left on closed issues
because only the bot path strips it (07 F42); "left for a human" exists only
in laptop logs (07 F39); a "review postponed" marker was identified and never
built (07 F16). The spec's change classes (product/bug/tooling/dependency,
section 3) and the feature-to-debt ratio (4.5) need label definitions that a
script can count (06 F24, F27).

**C3. Brief templates.** Precedents: kari's five role briefs with
`{{PLACEHOLDER}}` slots and stated contracts (plan: Approach, Files, Tests,
Risks, Out of scope; reviewer: CLEAN or numbered findings; worker: finish at
PR-open) (04 F21; 02 F8, F22); superpowers' implementer, task-reviewer and
code-reviewer prompts (02 F10, F14, F15); uv's prompt files with JSON output
schemas per stage (04 F58); toolhive's `triage-results.json` (04 F59).
Open: whether every stage emits schema-validated JSON (Claude Code's
`--json-schema` has an open serialisation bug, 03 F52); how briefs reference
the spec and ADRs the filing agent must load (process-spec 4.2).

**C4. Fix-loop limits.** Numbers in evidence: five rounds with a tier bump at
four and adjudication at the cap (02 F10); two surviving cycles → plan agent →
human (02 F21; 05 F28); two failed corrections → clear and re-prompt (02 F16).
kari's data: 26% of merged agent PRs had at least one findings round, 11 of
114 had two or more, median three commits per PR, and the valve's firing count
is unrecorded (07 F36, F39; 05 F28). Cost per cycle is a strong-model review
plus a cheaper fix plus a CI run (05 open question 11); "turn count beats
token price" argues for a mid-tier floor on fixers (02 F12).

**C5. How the grilling bot posts to issues.** Settled part: GitHub first
(S10). Open: resume the harness session by id across messages (every
candidate supports it on the same machine, 03 F39 to F44; 04 F36) versus
re-create from the issue each time (04 open question 6); one issue per
session with the design tree as comments (process-spec 4.1); whether only the
orchestrator may send (kari's rule, unenforced, 02 F23; 07 F49); pacing per
C1's interview bound; outbound rate limits (one message per second per chat,
04 F77).

### Piece D: agent runtime

**D1. Harness.** Survivors pi, OpenCode, Goose, Hermes (S11); the hands-on
task and ten measurements are specified at the end of file 03. Sub-questions:
whether open source is hard or soft for a Claude-only worker stage behind an
open-source orchestrator (03 F2, F12, F28, F46; 03 open question 1); skills
tree compatibility (`.agents/skills` read by pi, Codex, OpenCode, Goose;
`.claude/skills` by OpenCode and Goose only; 03 F27 to F31); permission
posture for unattended workers: container (pi has no permission system,
03 F45), OS sandbox that "fails rather than prompts" (Codex, 03 F47), rule
maps (OpenCode, 03 F48), Claude's `dontAsk`/`--permission-prompts none`
(03 F46); whether Codex hooks run under `codex exec` (03 F29); Hermes's
suitability as a coding harness and its unread tracker (03 F56, F57); project
stability given three org moves in a year (03 F1, F4, F5).

**D1b. Orchestration: build, adopt, or adopt-and-extend.** (a) Build on the
predecessor's ~900-line dispatcher with its test harness and incident fixes
(04 F1 to F27; 07 F50); no tool provides pull-on-completion *and* bot-authored
authority *and* Telegram *and* model-agnostic together (04 Tables 1 to 3).
Against: the predecessor accumulated prompt-only rules (04 F6, F9, F18 to
F24; 07 F49). (b) Adopt a tracker-polling orchestrator: Symphony's spec
matches 6.2's slot model exactly but is Linear/Codex-only (04 F65); Baton is
23 stars, last pushed March (04 F66); Multica replaces GitHub as tracker
(04 F67); Bernstein is a run-graph executor (04 F68). (c) GitHub Actions on
the self-hosted runner: uv, toolhive, dyad show issue→triage→fix with
schema-gated stages and App identities (04 F58, F59, F60); against: 5-minute
floor, load delays, 60-day auto-disable, concurrency groups queue but do not
rank, the open cron-auth bug, and the public-repo warning (04 F54, F55, F56,
F57). Sub-questions: a hosted trigger as watchdog with the laptop as executor
(Routines `/fire`, Copilot assign-by-API, `repository_dispatch`; 04 F29, F44,
F55); self-hosted runner on a public repo (04 F57; existing deploy job already
there); where quota fallback lives (04 F8, F34, F65); fleet-level daily cap
versus per-run caps (04 F34, F63, F71; 05 F27); which security posture to
borrow (gh-aw read-only agent + validated writer and its five advisories,
04 F63, F64; uv's sibling-repo context branch, 04 F58).

**D2. Agent definition fields.** kari: `name, enabled, every, model,
fallback` (04 F3); OpenCode: `description, mode, model, temperature, prompt,
permission, steps` (03 F30); gh-aw: `max-turns, max-ai-credits,
max-daily-ai-credits, timeout-minutes, concurrency, network` (04 F63); Baton:
tracker labels, polling, `max_concurrent`, `max_turns`, `permission_mode`
(04 F66); Claude subagents: `model:` per file (03 F28). Under
pull-on-completion `every:` disappears; per-run bounds (S12) and the tier
policy (S15) become frontmatter candidates.

**D3. How findings are queued.** No precedent for a worker-side findings
queue with a separate filing agent (02 F47). Building blocks: JSON artifacts
because models are "less likely to inappropriately change" them (01 F30);
schema-validated stage outputs (04 F58, F59); uv persists per-issue context to
a branch in a sibling repository under a short-lived token (04 F58); kari's
validator requires a fresh session and a SHA-freshness diff (02 F43). Open:
where the queue lives (repo branch, sibling repo, state directory, database);
record schema; how the filing agent loads architecture docs and ADRs; how
"not an issue" verdicts are kept; security routing to private vulnerability
reporting (process-spec 4.2) which no file covered.

**D4. Telegram bot implementation.** Options: build on the Bot API (free,
long-poll friendly, kari's ~400 lines of bash as reference, 04 F10, F77, F78);
Claude Code Channels (research preview, Claude-only, feeds a running session,
cannot start or resume one, needs a persistent `claude` process and Bun;
04 F79); OpenClaw (harness-agnostic, pairing, very large dependency; 04 F83);
Hermes's built-in gateway and cron (03 F32; general-purpose, untested as a
coding harness, 03 F57); Multica's community channel (04 F84). Favours build:
model-agnostic by construction and the spec's "persistent long-polling
process" (6.3) is ~one process. Favours Hermes: nothing to write, if D1
selects it. Also open: sender allowlist, `/pause` `/status` commands (04 F10,
F12), alert rate limits (04 F11; 02 F23), and the recorded cwd bug class
(07 F20).

**D5. Token efficiency techniques (beyond S15).**
- *Cost model under pull-on-completion.* The predecessor's empty-tick floor
  was ≈ $0.63 and its prefix was cold at every 6 h tick (05 F3, F22). Options:
  one long-lived orchestrator kept warm within TTL; short per-task sessions
  with `--bare`; a script scheduler that spends no tokens with model sessions
  only for workers (05 open question 1).
- *Cache TTL per bucket.* All predecessor writes were 1 h at 2x (05 F6);
  break-even is two reads per 1 h write (05 F18); Claude Code defaults to 1 h
  for the main loop on a subscription and 5 min for subagents (05 F22).
- *Tiering under current prices.* The 58/42 judgment/implementation split was
  measured at Fable 5 and Opus 5 prices; Fable 5.1 reads are a quarter of
  Fable 5's, Opus 5.5 is $4/$20 (05 F7, F19). Options: keep fable/opus;
  Opus 5.5 for implementation; Sonnet 5.5 for fixes; one model with per-stage
  effort (Codex's approach, 05 F29); query-level routing (RouteLLM, no harness
  support, 05 F33). No recorded incident attributes a defect to the cheaper
  tier (05 F28).
- *Per-stage attribution.* Model is only a proxy for stage; the result
  object has no per-subagent breakdown (05 F7, F20). Options: `stream-json`
  with `parent_tool_use_id` parsed into a ledger (05 F27); one headless
  session per stage; accept the proxy (06 F23, F43).
- *Budget bounds per run.* 4.5% of spend died in 429-killed ticks and nothing
  was bounded except the $2 retry (05 F8, F9); per-tick p90 was ≈ $17 (05 F3).
  Options: `--max-budget-usd`/`--max-turns` per stage where the harness has
  them (03 F12, F18); supervisor-enforced from events elsewhere (S12); a
  fleet daily cap in the scheduler.
- *Plugins and skills in headless runs.* The predecessor removed a ~1.6k-token
  per-session plugin on an unmeasured quality claim (05 F15). Options: none in
  headless; measure first.
- *Context editing versus compaction versus short stages.* Auto-compaction
  at ~967K on 1M models; server-side `clear_tool_uses` has the only measured
  effect (−84% tokens, internal eval) but needs SDK-level control (05 F24,
  F25, F26).
- *CI runner placement.* Hosted standard runners are free on a public repo;
  self-hosted costs laptop availability; HIL is self-hosted by necessity
  (05 F11, F35).

**D6. Laptop failure modes still open after S16.** A limit-killed tick still
strands claims (#322 open; 07 F11, F16); local/CI coverage drift (#398 open;
07 F24); the judgment-tier wedge: postpone (wedged ~20 h), downgrade
(rejected as losing reviewer independence), second provider for the gate, or
`MAX_IN_FLIGHT` > 1 (07 F19; 07 open question 2); Claude Code's open issue
that the background-wait ceiling hides the cause of death (03 F52); no
monitoring beyond `--status` (07 F46; 06 F46); sleep handling: inhibit and
accept missed slots (04 F14) versus Desktop's one catch-up (04 F32) versus
Multica's queue-while-offline (04 F67); interactive coexistence with a
concurrent `claude` session in the same repo (03 F14; hands-on measurement
10).

### Piece E: measurement

**E1. Final metric set and definitions.**
- *Rework.* DORA's is deployment-level (06 F1); the spec's is fix cycles per
  PR (06 F19); agent-PR studies use CI-failure counts and review rounds
  (06 F15). Collectable from review states (06 F38), runs by `head_sha`
  (06 F40), or post-merge reverts.
- *Spec deviation.* No published metric; nearest are rejection taxonomies
  (06 F15, F16, F20). Options: the review agent emits a finding category
  (scope / missed criterion / standards) that is counted; human labelling.
- *Spec churn.* Known as requirements volatility (NASA SWE-200) (06 F21);
  count edits to `specs/*.md` after the approval label via timeline plus git.
- *Time to green and CI failures.* Strongest single predictor of non-merge
  (06 F15, F22) and the most natural target for test weakening (06 F51); the
  coverage ratchet and golden-pixel tests are the structural guards.
- *Cost per merged PR by model and stage.* Nobody publishes it (06 F23);
  depends on D5's attribution choice (06 F43; 05 F7).
- *Product versus machinery.* Path-based at merge time (28% versus 46%
  depending on rule; 07 F34, F35) versus label at triage (06 F24; 07 open
  question 5).
- *Escape rate.* Change fail rate is the analogue; no agent-specific data
  (06 F25); needs telemetry joins.
- *Human interventions.* No published definition (06 F26); candidates:
  `needs-human` events (median wait 16.1 h, 20 asks in 34 days; 07 F42),
  maintainer review states, Telegram replies (11 on record; 07 F43), manual
  stable promotions; "left for a human" must first be recorded on GitHub
  (07 F39).
- *Feature-to-debt ratio worked.* Only as prompt text before (06 F27); the
  open backlog is 54% `tooling` (07 F46).
- *Queue age and lead time.* Kanban definitions exist (06 F28); timeline
  events give label-state ages (06 F39).
- *Perception.* SPACE says measure it; METR shows self-report diverges from
  measurement (06 F6, F12, F49). Options: a periodic one-line self-rating;
  none.
- *Storage.* Postgres plus admin page (process-spec 7) versus derive on demand
  from GitHub timeline plus usage JSON (06 F39 to F42; 06 open question 6);
  activity counts stored only as denominators and excluded from any report an
  agent reads (06 F48).

**E2. Thresholds for the autonomy ladder.** No source gives a threshold for
code-change autonomy (06 F36); progressive delivery gives the shape (metric,
interval, count, failure limit, inconclusive pauses for a human) (06 F31); AWS
adds a rolling 50-action window, hysteresis and immediate demotion on a safety
floor, without data (06 F33); jade's per-item blockers (retry, tests not run,
security flag, protected path) and a per-run auto-merge cap (06 F34). With a
few PRs per class per month a rolling window may never fill (06 open question
2). Options: fixed counts ("N consecutive merges with zero fix cycles and zero
escapes"); rate with a minimum sample; human promotion only (kari's and jade's
position); firmware stable with a metric plus a calendar floor (02 F42).

---

## 4. Contradictions

Places where two research files disagree, or where a source contradicts a
settled principle in the process spec. Both sides stated; nothing
recommended.

1. **"Two thirds machinery" versus the full record.** Process-spec 7 and
   files 02 and 05 carry the predecessor's own figure (02 F44; 05 F12). File
   07 reproduces it for the three-day window (66% any-product rule, 77%
   majority rule) and shows the share fell to 1/10, 4/26, 0/16, 0/9, 1/9, 0/4
   per week afterwards; over all 114 merged agent PRs it is 28% or 46%
   depending on the aggregation rule (07 F34, F35). The spec's parenthetical
   describes the launch window, not the system.

2. **Self-hosted runner on a public repository.** Process-spec 6.1 settles the
   laptop as host "also ... the existing GitHub self-hosted runner"; GitHub's
   own guidance is that self-hosted runners "should almost never be used for
   public repositories" (04 F57). dyad does it anyway on a macOS runner
   (04 F60).

3. **Claude Code as a listed harness candidate.** Process-spec 6.6 names
   "Claude Code headless with the Agent SDK" as a candidate and makes
   model-agnostic a hard requirement; file 03 finds Claude Code is Claude-only
   and not open source (03 F2, F21). The candidate fails the spec's own hard
   rule; whether a Messages-API gateway could change that is undocumented
   (03 F21).

4. **"Never downgrade the judgment tier" versus the wedge.** Process-spec 6.5
   keeps model tiering from the predecessor; the predecessor's record shows
   that rule, combined with `MAX_IN_FLIGHT = 1`, held the only slot for ~20 h
   while the review gate waited on a quota reset (07 F19; 05 F9). File 05 notes
   no incident ever attributed a defect to the cheaper tier (05 F28), which
   is the premise for not downgrading.

5. **Rulings versus stop.** superpowers' SDD: "A running plan does not wait
   on a human", record a ruling and continue (02 F11). kari's worker brief:
   "STOP: do not guess at product decisions" (02 F22). The spec's one human
   gate sits between them.

6. **Fix-loop caps.** Five rounds with escalation at four (02 F10); two
   surviving cycles then plan then human (02 F21); two failed corrections then
   clear context (02 F16). None publishes rework data (02 open question 1).

7. **Interview bound.** Maximum five questions chosen by impact × uncertainty
   (02 F4) versus "frontier empty" with no cap (02 F1) versus one question per
   message (02 F3).

8. **Completeness assertion against a reported total.** Process-spec 6.4 says
   scripts "assert completeness against the reported total". File 06 finds the
   Search API's `total_count` can exceed what is retrievable (1,000-result cap,
   `incomplete_results`) and that list endpoints are the right source
   (06 F41); file 07 finds kari's shortlist paginates but asserts nothing and
   calls `--paginate` "complete by construction" (07 F30). The spec's wording
   assumes a total the list endpoints do not return directly (file 03's
   hands-on task proposes the `Link` header's last page or the search total as
   the check).

9. **Bot authorship as the authority signal.** Process-spec 4.3 keys on
   issues "authored by the pipeline's bot account" and 4.1 calls grilling
   output "validated by construction". The predecessor had no such account:
   all 627 issues carry the maintainer's login and provenance was a label the
   fleet applied to itself (07 F45; 02 F43). No tool provides author-based
   authority (04 open question 4).

10. **Rework definition.** DORA's "deployment rework rate" (06 F1) is a
    different quantity from the spec's "rework rate (fix cycles per PR)"
    (06 F19); DORA separately recommends "code rework rates" undefined
    (06 F4).

11. **Superpowers as design reference versus cost.** File 02 treats the
    superpowers skills as "one articulated system" and draws its loop design
    from them (02 F10 to F15); the predecessor retired the plugin for ~1.6k
    tokens per session plus an unmeasured "degrades Claude 5 output" claim
    (05 F15; 07 F6, F7; 01 F20). pi and Codex do not read `.claude/skills` at
    all (03 F27, F29).

12. **Guidance imports.** Claude Code: imports do not reduce cost because they
    load at launch (01 F4). kari's `CLAUDE.md` = `@AGENTS.md` is such an
    import, which is fine only because AGENTS.md *is* the file; a trim that
    moved detail behind `@` lines would save nothing, while kari's trigger
    lines (plain prose pointers) do (01 F18).

13. **Telegram sluggishness attributed to the timer.** Process-spec 6.3 says
    "the predecessor's sluggishness was its 15-minute timer, not the
    transport". The record shows the 15-minute grid was the dispatcher's, the
    pipeline ticked at 4 to 6 hours, and the human side had a median 16.1 h
    wait on `needs-human` with one 245 h case (04 F1; 07 F3, F42). The
    transport was polled every 15 minutes (04 F10), so the spec's claim holds
    for Telegram; the dominant latency was elsewhere.

14. **Sessions and cost double-counting.** File 03 recommends resuming by
    session id for the Telegram bot (03 F39 to F44); file 06 notes a resumed
    Claude Code session's result "already includes the session's earlier
    spend" from v2.1.277, so per-message cost sums double-count (06 F43;
    05 F20). Not a disagreement on facts, but the two files pull the design in
    opposite directions.

---

## 5. Ideas with no precedent

Approaches none of the sources use, that the research suggests might fit
panelator's constraints. **All untested.** Kept separate from section 1 by
design; each names the finding that shows the absence or the nearest partial
precedent.

1. **Event-woken local scheduler with pull-on-completion and a zero-token
   script loop.** No hosted or open-source tool schedules on completion
   (04 "What others do"; nearest: openclaw's `workflow_run` admission check,
   04 F62, and Multica's queue, 04 F67). Combined with a script that spends no
   tokens when nothing is due (05 open question 1), the predecessor's $0.63
   empty-tick floor disappears (05 F3). Untested.

2. **Author-filtered shortlist as a scripted gate.** No tool implements "only
   work issues authored by the bot" (04 open question 4; nearest: uv's
   repository check, toolhive's label/branch filters, gh-aw actor filtering,
   04 F58, F59, F63). Requires S8's App identity first. Untested.

3. **Scripted premise validation with a machine-readable verdict.** kari's
   validator is prose (02 F43; 07 F49); no vendor validates premise (02 F47).
   A script could enforce the fresh-session requirement, the SHA-freshness
   diff, and refuse to shortlist without a parseable `VALIDATED` record.
   Untested; the validation gate's effect was never measured (07 open
   question 9).

4. **Review gate as a required status check posted by the review agent under
   the App identity.** Copilot's approval satisfying a required-review rule
   (02 F24) and Prow/Mergify label gates (06 F32) are the partial precedents;
   none has an *own* spec-aware reviewer as the check. Closes the hole in
   07 F48. Untested.

5. **"Review postponed" marker on the PR when the judgment tier is limited.**
   Identified in the predecessor's record and never built (07 F16); with a
   model-agnostic harness the same marker can trigger a second provider for
   the gate (07 open question 2; 03 F20, F24). Untested.

6. **Per-stage cost ledger from one session per stage.** Nobody publishes
   per-PR-per-stage cost (06 F23); the predecessor's records attribute by
   model only (05 F7). One headless session per stage gives each stage its
   own result object and clean attribution at the price of extra startup
   (05 open question 4). Untested.

7. **Supervisor that bounds any harness from its event stream.** Only Claude
   Code and Goose bound runs natively (03 F12, F18); pi and Claude both emit
   per-message cost (03 F13, F33). A harness-neutral supervisor enforcing time
   and dollars would make S12 uniform across survivors. Untested.

8. **CI cap on the guidance file.** Codex's 32 KiB is a reader-side cap
   (01 F2; 05 F16); Airflow validates commands but not size (01 F11). A CI
   check failing on line or byte count, or on commands that do not exist,
   would be the first enforced budget on an agent's own guidance (05 open
   question 6). Untested.

9. **Findings queue as schema-validated JSON records on a branch.** Combines
   Anthropic's JSON-for-stability observation (01 F30), uv's per-issue context
   branch (04 F58) and schema-gated stages (04 F58, F59) into the spec's 4.2
   queue, which has no precedent (02 F47). Untested.

10. **Product/machinery ratio computed from changed paths at merge time.**
    Agent 7 did it by hand once with two aggregation rules (07 F34); nothing
    computes it continuously (06 F24, F52). Needs the rule fixed in advance
    (06 F18). Untested as a running metric.

11. **Counted dismissals as a reviewer-quality signal.** Sources let fixers
    dismiss with a reasoned comment (02 F16, F22, F27) but nobody counts them
    (02 open question 12). Untested.

12. **Autonomy ladder for low volumes: class-in-advance plus per-item
    demotion plus recorded outcomes, promotion by fixed consecutive counts.**
    The AWS window-based score has no data (06 F33) and may never fill at a
    few PRs per class per month (06 open question 2); jade's blockers are
    per-item (06 F34). The hybrid is untested.

13. **Firmware stable promotion with a metric and a calendar floor.** All
    four OTA projects use calendar only (02 F42); Argo/Flagger thresholds are
    for services (02 F36, F37). Untested on firmware.

14. **Harness-neutral skills under `.agents/skills` with a symlinked
    `.claude/skills`.** pi and Codex read `.agents/skills` only; OpenCode and
    Goose read both; Claude Code reads `.claude/skills` only (03 F27 to F31).
    One tree serving all is untested.

15. **Activity metrics stored only as denominators and excluded from
    agent-readable reports.** Suggested by the Goodhart findings (06 F47, F48)
    and the spec's grooming agent reading the numbers; no source does it.
    Untested.

16. **Quota-aware scheduler state.** Instead of a tick that "simply dies"
    (07 F52) and a 429 retry (05 F9), a scheduler that reads the harness's
    rate-limit exit (Hermes documents exit 75 for rate-limited, 03 F19) and
    pauses the affected tier until a known reset. Untested.

---

## 6. Gaps

What the research run did not cover and should, before or during the
thinking run.

1. **The harness hands-on phase.** Not run; file 03 ends with the task and
   measurements (03 status; 03 "Recommended hands-on task"). D1 cannot close
   without it.

2. **OpenAI "Harness engineering" post read only through snippets and a
   mirror** (01 F21, F29, F51, F55). Re-read in a browser before relying on
   the ~100-line map, the `docs/` layout, or the structural-test claims.

3. **No outcome evidence anywhere for spec methods, fix caps, review designs
   or guidance trims** (01 F32; 02 F9; 05 F14, F15; 07 F61). The spec's own
   metrics (section 7) would be the first; E1 should be designed to produce
   this evidence.

4. **Hermes Agent.** Issue tracker not searched, coding suitability untested,
   not evaluated as a Telegram channel in file 04 (03 F56, F57; 04 Table 3
   omits it).

5. **Per-stage cost in the predecessor.** 139 tick logs unread; the
   escalation valve's firing count and "left for a human" outcomes exist only
   there (05 F7, F28; 07 F39; 07 confidence).

6. **Unreached sources.** RIOT HiL CI config (02 F35), WLED's promotion rule
   (02 F41), Codex per-review cost and who may invoke review (02 F27, F28),
   whether Codex hooks run under `codex exec` (03 F29), Codex's compaction
   default (05 F25), DORA 2025 and AI Capabilities PDFs and the SPACE body
   (06 F3, F5, F6), OpenAI Usage API parameters (06 F11), OpenHands
   self-hosted resolver (04 F70), Agent Orchestrator docs (04 F69).

7. **Spec areas no file researched.** Security findings routing to GitHub
   private vulnerability reporting (process-spec 4.2); the sensitive-path
   security review and the WASM sandbox host (process-spec 5); golden pixel
   tests as a verify gate (process-spec 3); the ops watcher as a producer
   (process-spec 4.4); the backend's deployment target, which decides whether
   Argo/Flagger apply (02 open question 11).

8. **Tool limits not documented by their owners.** eslint-plugin-boundaries
   on dynamic and type-only imports, knip's limits (01 F34, F36); clippy's
   `disallowed_*` lints from training data only (01 F38); whether any
   Espressif repo runs `idf.py clang-check` in CI (01 confidence).

9. **Claude Code as a Claude-only worker behind another orchestrator.**
   Whether a Messages-API gateway can front non-Claude models is undocumented
   (03 F21); whether `claude-code-action` cron auth works on the ThinkPad
   runner is an open p1 bug to test (04 F54).

10. **pi's RPC mode and OpenCode's `serve` API** as the persistent session
    behind a Telegram bot were not read in depth (03 confidence; 03 F7, F30).

11. **Agent-contribution policy for the public tracker** is published by
    every project read (01 F57) and is in neither 9.1 nor the spec's intake
    section; community issues are explicitly deferred (process-spec 4).

12. **Multi-language, mostly-agent-written public repositories with a
    retrospective.** None found (01 F56); the only documented instance is
    OpenAI's internal one (01 F55).

13. **Validation gate effect in the predecessor.** 27 validation comments
    against 140 closes, no record of what was rejected (07 F47; 07 open
    question 9).

14. **Telegram outbound volume and alert firings** are counts only (07 F43);
    the grilling bot's expected message rate against the one-per-second limit
    (04 F77) is unknown.

15. **GraphQL collection path.** `PullRequest.reviewDecision` and
    `timelineItems` may collect E1's data in fewer requests than the REST path
    recorded (06 confidence).
