# 0001. Harness per model vendor: Claude Code for Claude, pi for everything else

Status: accepted
Date: 2026-10-03
Amends: [process-spec.md](../process-spec.md) section 6.6;
[design-tree.md](../design-tree.md) R7.Q5
Overrides: [research/08-synthesis.md](../research/08-synthesis.md) S11 and
closes its open question D1

## Context

Process-spec 6.6 made "model-agnostic" a hard requirement of the harness, and
the research run ruled Claude Code out as the fleet harness on that ground
(Claude-only, not open source: research/03 F2, F21; synthesis S11). It left
pi, OpenCode, Goose and Hermes as survivors pending a hands-on comparison.

Two facts change that:

- The fleet runs on the maintainer's existing subscriptions, not API keys:
  Anthropic at $100 a month and OpenAI at $20 a month. The Anthropic
  subscription is only usable through Claude Code. The OpenAI subscription can
  be used from a third-party harness, and the maintainer has logged pi in to
  it.
- The subscription sizes set the roles. Claude models carry most of the work.
  OpenAI models (GPT-6.1 Sol, for example) take smaller steps in the
  orchestration and act as fallback when Claude quota runs out.

## Decision

- Claude models run in Claude Code headless (`claude -p`).
- OpenAI models, and any model from another vendor added later, run in pi.
- Model-agnosticism is a requirement of the dispatcher, not of a single
  harness. The dispatcher starts each stage as its own headless session in the
  harness that stage's model belongs to, through one adapter per harness, and
  stages hand off through files, issues and pull requests.
- The hands-on harness comparison specified in research/03 is not run. Codex
  CLI, OpenCode, Goose and Hermes are not used.

## Consequences

- "Open source" is given up for the Claude side; pi is MIT (research/03 F1,
  F2).
- `--bare` cannot be used for Claude Code runs, because it never reads
  subscription credentials (research/03 F14). This removes one of the
  techniques listed in synthesis S15.
- pi has no permission system and recommends a container as the boundary
  (research/03 F45). Unattended pi workers need one.
- pi's exit status is not a success signal: it can exit 0 on a failed response
  or on empty output (research/03 F8, F51). The pi adapter decides success
  from the event stream.
- pi has no turn, cost or time bounds (research/03 F10). The dispatcher
  enforces them for pi runs; Claude Code runs can also use `--max-turns` and
  `--max-budget-usd` (research/03 F12).
- The two harnesses read different skills trees: `.claude/skills` for Claude
  Code, `.agents/skills` for pi (research/03 F27, F28). Shared skills need one
  tree linked to the other, or two copies.
- Quota fallback from Claude to an OpenAI model lives in the dispatcher,
  because a Claude session that has hit its limit cannot call anything
  (research/03 F61).
- A Claude Code agent can still call pi from its shell tool for a second
  opinion inside a task (`pi -p "<prompt>"`), but that spend and its bounds
  are invisible to the dispatcher, so it is not the mechanism for stages.
- Not verified: the usage limits of the $20 OpenAI plan under pi, and whether
  OpenAI's terms place conditions on subscription use from a third-party
  harness.
