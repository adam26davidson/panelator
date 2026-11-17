# 0003. Strong-tier stages fall back to the next-best Claude model on a model-only limit

Status: accepted
Date: 2026-10-29
Amends: [specs/001-scheduler-core](../../specs/001-scheduler-core/spec.md)
AC-25 ("given the stage is tagged `tier: strong`, then it is not retried on a
weaker model but postponed")
Decided by: the maintainer, directly to the coordinating session on
2026-10-29; carried by
[specs/013-quota-planning](../../specs/013-quota-planning/spec.md) AC-9

## Context

The Claude subscription has a limit shared by all Claude models (the
five-hour session limit, and a weekly limit) and limits on single models.
Overnight 2026-10-28/29 the subscription hit its Fable limit ("You've reached
your Fable limit. Switch to another model, ...") while the other Claude models
still worked. Spec 001 AC-25 postpones a strong-tier stage on any rate limit
and never moves it to a weaker model, so plan, review, spec and the strong
standing agents all idled. About 11 hours passed with no issue work, and the
findings filer alone made about 1,280 failing runs.

The rule came from the predecessor (process-spec 6.5; research 05 finding 9):
"never downgrade planning or the review gate ... to a smaller model". There the
alternative was a much cheaper model. Here the alternative is Claude Opus, the
next Claude model below Fable, and its quota was unused.

## Decision

The maintainer chose "allow the Opus fallback by default" on 2026-10-29.

- When only a strong-tier stage's own Claude model is limited (a model-scope
  limit such as the Fable limit), the stage runs on the next-best Claude model
  instead of waiting for the reset. This applies to ordinary strong-tier chain
  stages and to standing agents. It did not apply to rescues at first; the
  amendment of 2026-11-17 below extends it to them. The move happens up front when the limit is already known,
  or as one retry, capped by `retry_cost_limit_usd`, when a run hits it.
- A limit shared by all Claude models (session, weekly) never triggers this.
  The stage waits for the reset as before.
- The fallback is the parameter `quota.model_limit_fallback`, default `true`,
  mode `auto`. The model is `quota.model_limit_fallback_model`, default
  `claude-opus-5-5`. Both are in `agents/parameters.yaml`, so the maintainer can
  lock either one, and the system may change them while they are `auto`.
- Every such run is logged as `quota-fallback` in the service log, and its
  usage record names the model it ran on.

## Consequences

- Judgment work keeps moving through a model-only limit. The cost is that some
  plans and reviews are done by Opus rather than Fable. Reflection can compare
  their rework and review findings in the usage records.
- The no-weaker-vendor part of AC-25 stays: a strong-tier stage is still never
  moved to an OpenAI model because of a Claude limit (independent stages keep
  spec 006 AC-26).

## Amendment 2026-11-17 (maintainer decision): rescues fall back too

Decided by: the maintainer, on 2026-11-17.

The decision above left rescues out: the delivery design's section 4 (a
protected statement) made a rescue "one more attempt on the strongest model",
so a rescue under a Fable limit was postponed (spec 006 AC-27). In production
the rescue plan stage of issue #132 then held its slot for more than six hours
waiting on Fable, while an ordinary plan stage for issue #37 fell back to Opus
at once. While Fable is limited, the strongest model available is Opus.

- A rescue takes the model-limit fallback like any other strong-tier stage:
  up front when the limit is already known, or as the one cost-capped retry
  when its run hits the limit. Its run id ends in `-rescue-fallback` and its
  stage log record carries both `rescue` and `fallback`.
- When the fallback model is limited too, the rescue is postponed as before.
- Nothing else changes: the rescue still counts as the one rescue, gets the
  same history and input, and never takes a stage's own (non-Claude) fallback.
- The maintainer amended design section 4's rescue row to match: "one more
  attempt on the strongest available model (Fable, or Opus when Fable is
  limited, ADR 0003 amendment 2026-11-17)".
