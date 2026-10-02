# Research run brief

Status: draft for maintainer review, not yet run. Written 2026-10-02.

This file is the complete prompt set for the research run described in
[../process-spec.md](../process-spec.md) section 9. Seven reading agents run in
parallel, each writing one file into `docs/research/`. One synthesis agent runs
after all seven finish. The thinking run (a grilling session) follows the
synthesis.

How to run: dispatch each numbered prompt below to a fresh general-purpose
agent with web access, prepending the shared preamble verbatim. Dispatch the
synthesis prompt only after all seven files exist.

---

## Shared preamble (prepend to every agent prompt)

You are one of seven research agents for **panelator**, an open-source LED
dashboard whose repository will be developed mostly by AI agents. Your output
is one Markdown file. The maintainer and a later synthesis agent read it; they
decide, you inform.

Read first, in this order:

1. `/home/adamd/Projects/panelator/docs/process-spec.md`, the settled process
   principles and the open items you are researching.
2. `/home/adamd/Projects/panelator/docs/design-tree.md`, rounds 6 to 9 only,
   for why those principles were chosen.

Ground rules:

- **Primary sources only.** Official documentation, source code, specs,
  first-party changelogs, the maintainer's own records. A blog post or
  benchmark is a lead, and you follow it to the source that owns the claim
  before you record the claim. If you cannot reach a primary source, record the
  claim as unverified and say where it came from.
- **Today is 2026-10-02.** Your training data is older than the tools you are
  researching. Fetch current documentation for every tool; record the version
  or commit you read.
- **Cite every finding** inline with a URL or a repo-relative file path and,
  for source code, a line range.
- **Record what you did not find** as explicitly as what you found. An
  absence that the thinking run will rely on is a finding.
- You have read access to two local repositories as evidence:
  `/home/adamd/Projects/kari-website` (the predecessor automation system; its
  `automation/` directory, `automation/README.md`, `docs/`, `AGENTS.md`, and
  `git log` are primary sources for what actually happened) and
  `/home/adamd/Projects/char-matrix-dashboard` (the predecessor product).
  Modify nothing in either.

Output file structure, fixed so the synthesis agent can read seven files the
same way:

```
# <Title>
Status: complete | partial (say what is missing)
Date: 2026-10-02

## Question
The question(s) you were given, restated in one paragraph.

## Sources consulted
Bulleted list: what you read, with URL/path and version/commit/date.

## Findings
Numbered. One claim per finding, one or more citations per claim.
Tag each finding [verified] or [unverified].

## What others do
Patterns that recur across sources, each pointing back to the findings that
support it. This section is descriptive, never prescriptive.

## Open questions for the thinking run
Decisions the evidence does not settle, each with the finding numbers that
bear on it and the options the evidence leaves open.

## Confidence
One paragraph: where the evidence is strong, where it is thin, what you would
read next with more time.
```

Write the file to `/home/adamd/Projects/panelator/docs/research/<NN>-<slug>.md`
with the number and slug given in your prompt. The file is complete when every
question in your prompt has at least one finding or an explicit "not found",
every finding has a citation, and the Open questions section names every
decision your findings leave open. Then stop; the synthesis is someone else's
job.

---

## Agent 1: repo internals for agent-maintained codebases

File: `01-repo-internals.md`

Question: what makes a multi-language repository (TypeScript, Rust, C under
ESP-IDF, WebAssembly) navigable and safe for AI agents to work in, and which
tools enforce that automatically?

Investigate:

1. **Agent guidance files.** How `AGENTS.md`, `CLAUDE.md` and equivalents are
   structured by projects that publish theirs. Read the AGENTS.md spec at its
   source and at least five real examples from active repositories with
   substantial agent contribution. Record size, structure, whether they point
   to other docs or inline everything, and how they are kept current (is there
   a CI check, a review rule, nothing?). Include kari-website's `AGENTS.md`
   history via `git log -p --follow AGENTS.md` and its issue #659 trim as one
   example with a recorded outcome.
2. **Specs and plans as repository artifacts.** How projects store feature
   specs, plans and ADRs so that agents implement from them. Read the
   superpowers plugin's writing-plans and brainstorming skills at
   `/home/adamd/.claude/plugins/cache/` as one approach, kari-website's
   `docs/superpowers/` as a worked instance, and at least two other published
   conventions (e.g. ADR tooling, RFC directories, spec-driven development
   tools). Record the template fields each uses and any claimed effect on
   implementation fidelity, with its source.
3. **Architecture enforcement tooling**, current versions and what each
   actually checks: steiger (Feature-Sliced Design), eslint-plugin-boundaries,
   dependency-cruiser, knip, Biome; for Rust, clippy lint groups, cargo-deny,
   cargo-udeps or equivalents, workspace lint tables; for C/ESP-IDF,
   clang-tidy, include-what-you-use, IDF's own checks; for JSON Schema drift,
   schemars and how projects fail CI on schema changes. For each, cite the
   official docs and say what rule classes it enforces and what it cannot.
4. **Navigability properties.** Published guidance from harness vendors
   (Anthropic, OpenAI, Google) on what makes code easy for their agents: file
   size, module boundaries, test-as-documentation, naming. Primary sources are
   their official docs and engineering posts, not summaries.
5. **Multi-language monorepos maintained mostly by agents.** Find any that
   exist publicly, describe their layout, and record anything they wrote about
   what went wrong.

---

## Agent 2: feature lifecycle practices

File: `02-lifecycle-practices.md`

Question: how do teams running agent-driven development move a change from
request to production, and which gate and loop designs have published
evidence behind them?

Investigate:

1. **Requirements extraction.** Published methods for turning a vague request
   into an implementable spec with an agent: structured interviewing (the
   grilling skill at `/home/adamd/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/` is one; read its source and its design rationale if any), spec templates, acceptance-criteria formats. What do they claim improves fidelity, and what is the evidence?
2. **Plan, implement, review loops.** How harness vendors and published
   projects structure the plan → implement → review → fix loop: subagent
   dispatch patterns, fix-cycle limits, escalation when a loop stalls. Read the
   superpowers skills (subagent-driven-development, executing-plans,
   requesting-code-review, receiving-code-review) as one articulated system,
   and kari-website's `automation/agents/issue-pipeline.md` plus its brief
   templates as a deployed one; record where the deployed one deviated from
   the designed one and why (the git log and `automation/README.md` say).
3. **Agent code review.** How automated reviewers are run at the PR gate:
   GitHub's own, Anthropic's `claude-code-action`, OpenAI's Codex review,
   others. What they check, what they can block, false-positive handling,
   cost per PR where published.
4. **Verification gates for firmware.** How open-source embedded projects run
   hardware-in-the-loop in CI: self-hosted runners, device farms, flashing and
   telemetry assertions. Find at least two with public CI configs and record
   the pattern.
5. **Release safety under autonomous merge.** Canary and rollback patterns for
   small services; firmware channel promotion (beta → stable) in projects that
   ship OTA to users' devices (ESPHome, Tasmota, WLED, Home Assistant are
   candidates). Record their actual promotion rules and who performs them.
6. **Issue authority and validation.** Any published handling of the problem
   that agents treat tracker items as authoritative: validation steps,
   provenance labels, separate queues. kari-website's `docs/issue-validation.md`
   and the pipeline's recorded "two thirds machinery" measurement are
   evidence; find external instances too.

---

## Agent 3: harness evaluation (reading phase)

File: `03-harness-evaluation.md`

Question: which coding-agent harness fits panelator's criteria, and what does
each one actually support today?

Criteria, from the process spec section 6.6: open source; runs headless on our
own runner; model-agnostic with a wide variety of models pluggable; skills or
an equivalent extension mechanism; cost controls and usage reporting; coexists
with interactive Claude Code use. Model-agnostic and headless are hard
requirements.

Candidates: pi (badlogic/pi-mono or its current home), Claude Code headless
and the Claude Agent SDK, OpenAI Codex CLI, OpenCode. Add any other harness
that meets the two hard requirements and has a public repository with
sustained activity; record why you added it.

For each candidate, from its official docs and source at the current version:

1. Licence and repository activity (commits in the last 90 days, open issues,
   maintainer count).
2. Headless invocation: the exact command or API, output formats, exit codes,
   how a run is bounded (turns, time, cost).
3. Model support: which providers, how a model is configured per run, whether
   different stages of one workflow can use different models, local model
   support.
4. Extension mechanism: skills, plugins, hooks, MCP, custom tools. What each
   can and cannot intercept.
5. Cost and usage reporting: what the harness itself emits per run.
6. Session persistence and resume, which the Telegram grilling bot depends on.
7. Sandboxing and permission model when run unattended.
8. Known gaps relevant to our criteria, from the issue tracker.

Then a comparison table across all candidates and criteria, with each cell
citing its source. Record which candidates survive the two hard requirements.

Note for the maintainer: the hands-on phase (one real task through each
surviving harness on this repo, using Anthropic and OpenAI models) needs
installs and API keys and is dispatched separately after this reading phase.
End your file with the exact task you recommend for that hands-on comparison
and the measurements to take.

---

## Agent 4: orchestration tooling that replaces hand-built automation

File: `04-orchestration-tooling.md`

Question: kari-website built its own fleet by hand: a systemd timer, a
dispatcher shell script, agent definitions in Markdown with frontmatter, a
Telegram poller, usage accounting, concurrency limits and fallback rules. Which
existing tools or services do some or all of that today, and how well do they
fit panelator's settled principles (pull-on-completion scheduling, bot-authored
issue authority, model tiering, cost caps, agents running on the maintainer's
laptop, Telegram as the human channel)?

First read `/home/adamd/Projects/kari-website/automation/README.md`,
`automation/dispatch.sh` and `automation/agents/*.md` and list every capability
that system provides, as the checklist you evaluate tools against.

Then investigate, from official docs and source at current versions:

1. **Harness-native scheduling and cloud agents.** Claude Code's scheduled
   routines and cloud sessions, OpenAI Codex cloud tasks, GitHub Copilot's
   coding agent (assign an issue, get a PR), Google Jules, Cursor background
   agents. For each: what triggers it, where it runs, what it can read and
   write, model choice, cost model, whether it can be driven from our own
   runner.
2. **GitHub-native orchestration.** Scheduled and event-triggered Actions
   running `claude-code-action`, Codex's action, or a harness CLI directly;
   self-hosted runners; concurrency groups; how issue → agent → PR flows have
   been built on Actions alone. Find at least three public repositories doing
   this and record their workflow files.
3. **Open-source agent orchestrators and issue resolvers.** OpenHands and its
   GitHub resolver, Aider's automation modes, SWE-agent, and any actively
   maintained project whose purpose is "run coding agents against a tracker on
   a schedule". Record trigger model, concurrency handling, model routing,
   cost accounting, human-escalation channel.
4. **General workflow engines used for agent fleets.** Temporal, Dagger,
   Prefect, n8n or similar where public write-ups show them orchestrating
   coding agents. Record only instances with primary sources.
5. **Human channels.** Telegram, Slack and Discord bot frameworks and any
   harness-native chat integrations (e.g. Claude in Slack) that can open or
   resume an agent session from a message; what they cost in setup and
   hosting.

Close with a fit table: rows are kari-website's capabilities, columns are the
tools, cells say "provides / partial / absent" with a citation. Then the open
question the thinking run must answer: build, adopt, or adopt-and-extend, with
the evidence for each.

---

## Agent 5: token and cost efficiency

File: `05-token-efficiency.md`

Question: how do agent-driven projects keep token cost per merged change down
without losing quality, and what did kari-website measure?

Investigate:

1. **kari-website's own record.** From `automation/README.md` (Usage limits,
   Throughput sections), the usage JSON files it keeps, issues referenced in
   commits about cadence changes (#434, #626, #635, #667, #693, #827 and any
   others `git log --grep` finds), and `issue-pipeline.md`'s model policy:
   reconstruct cost per merged PR by stage and model where the data allows,
   and the sequence of cadence decisions with their stated reasons.
2. **Prompt caching.** Current official documentation from Anthropic and
   OpenAI on cache behaviour, TTLs, pricing, and what breaks a cache. How
   harnesses exploit it (Claude Code's own documentation on context and
   caching, Codex's, pi's).
3. **Context management.** Compaction, summarisation, context trimming, and
   subagent isolation as cost levers: what each harness documents, and
   published measurements of their effect.
4. **Model routing by stage.** Published results, from vendors or projects,
   of using a stronger model for judgment and a cheaper one for implementation,
   including failure cases.
5. **Guidance file cost.** The per-turn cost of always-loaded material
   (`AGENTS.md`, skill descriptions, MCP tool schemas); kari-website disabled
   the superpowers plugin for this reason (#540) and trimmed `AGENTS.md`
   (#659). Find the token counts and any measured effect.
6. **Batching and CI cost.** Combining small issues into one PR, skipping
   redundant CI, and what GitHub Actions minutes actually cost on hosted vs
   self-hosted runners at current pricing.

---

## Agent 6: measurement

File: `06-measurement.md`

Question: how do teams measure whether agent-driven development is working,
and which metrics have been shown to drive good decisions about autonomy?

Investigate:

1. **Published metric sets** for AI-assisted and agent-driven engineering:
   DORA's current research on AI in software delivery, SPACE, vendor
   dashboards (GitHub Copilot metrics API, Anthropic and OpenAI usage
   reporting), and any academic or industry study with a defined metric set
   and data. Record each metric's definition and what the source claims it
   predicts.
2. **The candidate list in the process spec section 7**, metric by metric:
   has anyone defined and used it, under what name, with what result?
3. **Autonomy ladders.** Any published scheme where a class of change earns
   less human review based on measured outcomes (rework, escape rate). Look in
   progressive-delivery and dependency-automation practice (Renovate and
   Dependabot auto-merge policies are a deployed instance) as well as
   agent-specific writing.
4. **Collection mechanics.** How metrics are gathered from GitHub (API fields
   for review cycles, time to merge, labels), from CI, and from harness usage
   output, so the thinking run knows what is cheap to collect and what is not.
5. **Known pitfalls.** Goodhart effects and gaming reported for these metrics,
   with sources.

---

## Agent 7: kari-website retrospective

File: `07-kari-website-retrospective.md`

Question: what actually happened in the predecessor automation system, as
evidence rather than memory?

This agent reads only the local repository `/home/adamd/Projects/kari-website`
and the GitHub repository it pushes to (use `gh` read-only: issues, PRs,
Actions runs, labels). Primary sources: `git log` with full messages,
`automation/README.md`, `automation/agents/*.md`, `docs/`, `.github/`, issues
and PRs by label (`agent-pr`, `automation`, `needs-human`).

Produce, each with citations to commits, issues or files:

1. **Timeline** of the automation system from its first commit to today: each
   structural change (cadence, concurrency, model policy, new agent, new
   guard) with its stated reason.
2. **Incident list**: every recorded failure, its root cause as the record
   states it, the fix, and whether it recurred.
3. **Throughput**: merged agent PRs per week, split product vs machinery
   (reproduce the pipeline's own "two thirds" measurement from PR titles and
   labels; show the method), fix cycles per PR where derivable, PRs left for a
   human.
4. **Human load**: how often `needs-human` fired, how long items waited, how
   many Telegram exchanges, how many issues the maintainer filed vs agents.
5. **Rules that live only in prompts**: list every rule in the agent Markdown
   files that no script enforces, since the process spec requires the opposite.
6. **Pagination and completeness bugs**: the maintainer recalls the issue
   listing silently truncating; find the commit or issue, the cause and the
   fix.
7. **What the system's own documents say worked**, verbatim where short.

Descriptive only: the thinking run interprets.

---

## Synthesis agent (runs after files 01 to 07 exist)

File: `08-synthesis.md`

Read all seven files in `/home/adamd/Projects/panelator/docs/research/`, then
`/home/adamd/Projects/panelator/docs/process-spec.md`.

Write one document with exactly these sections:

1. **What others do.** The recurring patterns across all seven files, each
   with the file and finding numbers that support it. Descriptive.
2. **What the evidence settles.** Open items from process-spec section 9.1
   that the research answers outright, with the answer and its support. These
   become ADR candidates.
3. **Open questions for the thinking run.** Every open item the evidence does
   not settle, grouped by piece (B, C, D, E), each with the options the
   evidence leaves open and what favours each. This section is the agenda for
   the grilling session; it is complete when every open item in section 9.1
   appears in either this section or the previous one.
4. **Contradictions.** Places where two research files disagree or where a
   source contradicts a settled principle in the process spec. State both
   sides; recommend nothing.
5. **Ideas with no precedent.** Approaches that none of the sources use and
   that the research suggests might fit panelator's constraints. Mark each
   clearly as untested. This is the raw material for deliberate innovation
   and must stay separate from section 1.
6. **Gaps.** What the research run did not cover and should, before or during
   the thinking run.

Keep every claim traceable to a numbered finding in files 01 to 07. Add no new
research.
