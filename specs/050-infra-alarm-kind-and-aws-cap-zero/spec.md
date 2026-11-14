# 050. Every `infra_alarm` carries a `kind`; spec 022's policy drops `ce:GetCostForecast` and its scheduled pull waits while the cap is 0

Status: written 2026-11-07 from the delivery-system design for issue #100;
specs derived from that design need no maintainer approval (design section 11).
This spec marks, as section 4 records:
[022-delivery-aws-account](../022-delivery-aws-account/spec.md) AC-3, AC-4,
AC-9, AC-10, the section 4 paragraph "`infra_alarm`, not a new event.",
section 6, and the section 8 paragraph "2. Give the pipeline least-privilege
access.";
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) AC-8;
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-5; and [030-beyond-github](../030-beyond-github/spec.md) AC-15.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("AWS for the delivery system": the cap enforced in code; "Credentials":
least privilege), section 6.1 (infra health is woken by `infra_alarm`), section 4
(agents resolve their own blockers; a flaw the filer records is fixed through an
ordinary spec) and section 10 ("Small work skips layers": a tooling spec hangs
directly off a top design); [charter](../../docs/charter.md) (a strictly
enforced cap on monthly AWS spend, configurable by the maintainer);
[008-agent-registry](../008-agent-registry/spec.md) AC-4 (the reserved event
name `infra_alarm`); and the four specs marked above.

## 1. Goal

Spec 022 (issue #37, not yet implemented) is correct in three places before it
is built:

1. **`infra_alarm` has producers already, and every payload says which alarm
   it is.** Spec 022 AC-9 and its section 4 say the event has had no producer
   and that spec 008 reserved it "for exactly this". On `main` two producers
   emit it for a network outage two hours old: the chain's (spec 015 AC-8,
   `tools/scheduler/src/service/loop.ts`, payload `{ issue, since, failures,
   cause }`) and the standing runner's (spec 045 AC-5,
   `tools/scheduler/src/standing/run.ts`, payload `{ agent, since, failures,
   cause }`). Spec 022's own payload is the only one with a `kind`. After this
   spec every `infra_alarm` payload has a `kind`: both outage alarms gain
   `kind: "network_outage"`, spec 022's keeps `kind: "aws_forecast_over_cap"`,
   and a subscriber (spec 030's infra health) branches on `kind`.
2. **The pipeline's AWS policy grants only what is called.** Spec 022 section 8
   grants `sts:GetCallerIdentity`, `ce:GetCostAndUsage` and
   `ce:GetCostForecast`. No criterion calls `ce:GetCostForecast`: AC-3 and AC-4
   call `ce get-cost-and-usage` and AC-5 computes the forecast in the
   scheduler. The maintainer copies this policy into IAM Identity Center when
   the implement stage raises its capability question, so the unused action
   goes now.
3. **No paid call is made on the scheduler's own initiative while the cap is
   0.** Spec 022 AC-4 pulls Cost Explorer whenever AWS is on and the interval
   has elapsed, at about one cent a call. With `aws_cap_usd` at 0 (its value
   today, which section 8 of spec 022 says means "launch nothing") that is
   about 0.30 USD a month the cap never sees: AC-8 notifies only against a
   non-zero cap. While the cap is 0 the scheduled pull is skipped; the free
   identity check of AC-2 still runs on the same interval so AWS on and off
   stays accurate, and `panelator-scheduler aws pull`, the maintainer's own
   command, still forces one.

### Why these answers *(agent's call)*

- **A `kind` on every alarm, not "no `kind` means an outage".** Spec 030 AC-15
  already tells infra health to file a finding for an alarm whose `kind` it
  does not know, and reads spec 015's alarm as the one "whose payload has no
  `kind`". That rule leaves a missing field carrying meaning, and a third
  producer written without a `kind` would be taken for an outage. One field
  every payload has, with the set of values listed here, is the shape a
  subscriber can check. The chain's and the runner's alarms share the value
  `network_outage` because they are the same alarm about different holders,
  told apart by `issue` or `agent`, which the payloads already carry. The
  cost is one field in two emits and their tests; no subscriber of
  `infra_alarm` exists on `main` (neither standing definition in
  `agents/standing/` lists it), so no stored pending event has the old shape
  and nothing reads it.
- **Drop the action rather than give it a use.** The design asks the
  scheduler for its own forecast (spec 022 AC-5: the ledger view counts what
  the system just launched before AWS reports it); AWS's forecast would be a
  second paid call a day that adds nothing the two views do not.
- **Skip, rather than accept and count.** The charter calls the cap strictly
  enforced, and the maintainer recorded 0 as "launch nothing". Counting the
  pulls' own cost would still spend against a cap of 0 every day, and nothing
  the scheduler does at cap 0 needs the actual figure: reservations are
  refused at cap 0 (spec 022 AC-6), and the thresholds and the forecast alarm
  apply only to a non-zero cap (AC-8, AC-9). `aws-check` follows the same rule
  so the implement stage's setup check is not a paid call either. A call the
  maintainer asks for by name is the maintainer's spend, made knowingly. This
  enforces a recorded decision rather than changing it, so it is not a
  question for the maintainer, and it is small and easily reversed, so it
  has no ADR.

## 2. Out of scope

- Everything else in spec 022: the account, the ledger and launch gate, the
  forecast's arithmetic, the thresholds, the budget and its service control
  policy, the commands' other output. Unchanged.
- The rest of the outage handling of specs 015 and 045 (backoff, ceiling, the
  finding, the `infra` notification, the log lines): unchanged. Only the event
  payload gains a field.
- What infra health does with an alarm (spec 030 AC-15, issues #39, #124 and
  #130): it keeps its limits; only how it recognises the outage alarm changes.
- Spec 008's text calling `infra_alarm` a name "with no producer": true when
  written, and spec 008 is the reservation, not a producer's description.
- Event-store kinds (spec 026): `infra_alarm` is a standing-agent trigger
  (spec 008 AC-4), not an event-store kind, so no schema in
  `schemas/scheduler/` changes.
- `docs/charter.md`, `agents/sensitive-paths.txt`, the security review
  criteria and instructions, and what routes a sensitive diff to the security
  review: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch and the test
worlds of `tools/scheduler/test/loop.test.ts` (the chain outage world) and
`tools/scheduler/test/e2e.test.ts` (the standing world), or, for AC-4 to AC-8,
spec 022's own test setup (the fake `aws` command of its section 6).

**One shape for `infra_alarm`**

- AC-1. Amended by [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md) AC-4: the payload's kind is `disk_full` when the outage's cause is `ENOSPC`. **The chain's outage alarm carries `kind`.** Given an outage of a
  claim two hours old with `alarmed` false (spec 015 AC-8), when the loop
  raises the alarm, then the one `infra_alarm` event it emits has payload
  `{ kind: "network_outage", issue, since, failures, cause }`; the log line,
  the finding and the notification are as on `main`.
- AC-2. **The standing runner's outage alarm carries `kind`.** Given a
  standing agent's outage two hours old with `alarmed` false (spec 045 AC-5),
  when the runner raises the alarm, then the one `infra_alarm` event it emits
  has payload `{ kind: "network_outage", agent, since, failures, cause }`; the
  log line, the finding (with its exclusion) and the notification are as on
  `main`.
- AC-3. **The kinds are listed, and subscribers branch on them.** Every
  `infra_alarm` payload has a string `kind`. The kinds are `network_outage`
  (specs 015 AC-8 and 045 AC-5; the payload names the claim's `issue` or the
  standing `agent`) and `aws_forecast_over_cap` (spec 022 AC-9, with the
  payload that criterion gives). Spec 022 AC-9 emits the third producer's
  alarm, after the two outage producers, not the first. Spec 030's infra
  health (AC-15) reads an alarm of kind `network_outage` as the outage alarm
  it acts on today, and reports and files one finding, not acting, for any
  other kind it does not know or a payload without `kind`. A later spec that
  adds a producer adds its kind to this list in its own text.

**The pipeline's AWS policy**

- AC-4. **Two actions, nothing else.** The inline policy of spec 022 section
  8 step 2, used in option A's permission set and option B's IAM user alike,
  is:

  ```json
  { "Version": "2012-10-17", "Statement": [
    { "Effect": "Allow", "Action": [ "sts:GetCallerIdentity",
      "ce:GetCostAndUsage" ], "Resource": "*" } ] }
  ```

  and spec 022 needs only these two actions. The capability question the
  implement stage raises (spec 022 section 8) copies this policy, not the one
  printed in spec 022. Given the implementation of spec 022, then no code
  under `tools/scheduler/src/aws/` calls `ce get-cost-forecast`; the test
  that greps for `aws` invocations outside `src/aws/` (spec 022 AC-6) also
  asserts that `get-cost-forecast` appears nowhere under
  `tools/scheduler/src/`.

**No paid call of the scheduler's own while the cap is 0**

- AC-5. **The scheduled pull waits while the cap is 0.** Given the `aws`
  block configured, the cap 0 when the tick reads it (spec 022 AC-11), and
  the last successful pull older than `pull_interval_h` (or none yet), then
  the tick runs the identity check of spec 022 AC-2 and nothing else against
  AWS: no `ce get-cost-and-usage` call, `aws/cost.json` is not written, no
  `aws.cost` event is recorded, and the time of the last successful pull is
  unchanged. The identity check repeats every `pull_interval_h` while the cap
  stays 0 (its time is kept with the on/off state; a restart runs it at start
  as AC-2 does), so AWS on and off, and the `aws-access` notification on a
  change, stay as spec 022 AC-2 says. The service log records `{ kind:
  "aws-pull-skipped", reason: "aws_cap_usd is 0" }` once each time the
  skipping starts, and `{ kind: "aws-pull-resumed" }` once when a non-zero
  cap ends it. Given the cap then set above 0 (spec 008 AC-17), then the next
  tick pulls as spec 022 AC-4 says, at once when no pull succeeded within
  `pull_interval_h`. The failed-pull retries of AC-4 apply only to pulls that
  were made. Spec 022 AC-6, AC-8 and AC-9 need no figure at cap 0 and are
  unchanged.
- AC-6. **A forced pull is the maintainer's.** Given the cap 0, when
  `panelator-scheduler aws pull` runs (spec 022 AC-10), then it pulls, writes
  `cost.json` and records the `aws.cost` event as a scheduled pull does, and
  prints before its result that the call costs about one cent and is made
  although `aws_cap_usd` is 0. No prompt or standing definition in the
  repository, and no step of spec 022 section 6 or 8, tells an agent to run
  `aws pull`.
- AC-7. **The setup check makes no paid call at cap 0.** Given the cap 0, when
  `panelator-scheduler aws-check` runs (spec 022 AC-3), then it runs the
  identity check, does not call `ce get-cost-and-usage`, prints the caller ARN
  and account, whether it matches, the cap, the SSO expiry, and in place of
  the month-to-date cost the line `cost call skipped: aws_cap_usd is 0;
  panelator-scheduler aws pull makes one (about one cent)`, and exits 0 when
  the identity matches. Given a non-zero cap, it behaves as spec 022 AC-3
  says.
- AC-8. **The skip is visible.** Given AWS on and the cap 0, then each tick's
  service-log `aws` field (spec 022 AC-10) is `{ actual_usd, forecast_usd,
  cap_usd, reserved_usd, as_of, pull_skipped: "cap 0" }`, the first five from
  the last `cost.json` (each `null` when there is none, `cap_usd` 0), and
  `panelator-scheduler aws` prints, beside the rest of spec 022 AC-10, the
  line `scheduled pulls skipped: aws_cap_usd is 0` (`pull_skipped` in its
  `--json` output). Given AWS off, the field is `{ off: <reason> }` as spec
  022 says.
- AC-9. **The post-deploy write-up at cap 0.** Given the service restarted on
  spec 022's merged code with the cap still 0, then the `dev-logs/` write-up
  spec 022 section 6 asks for records the identity check, the
  `aws-pull-skipped` line and the tick's `aws` field instead of a first real
  pull, and the first real pull is written up when the cap is first raised.

**Where it lands**

- AC-10. **The earlier text is marked.** The spec PR prepends to each unit
  named in the status line an `Amended by
  [050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md)
  AC-k: <one clause>.` mark, as section 4 lists, and changes nothing else in
  those specs.
- AC-11. **What the implementation changes.** The implementation of this spec
  (issue #100) changes the two emits of AC-1 and AC-2 and their tests: the
  loop test of spec 015 AC-8 in `test/loop.test.ts` asserts `kind:
  "network_outage"` in the payload, and the spec 045 AC-5 test in
  `test/e2e.test.ts` expects the payload `{ kind: "network_outage", agent,
  since, failures, cause }`. AC-3 to AC-9 are built by spec 022's
  implementation (issue #37), which reads them through the marks; if spec
  022's implementation is on `main` when this spec's implementation is
  planned, this spec's implementation brings `tools/scheduler/src/aws/`,
  `tools/scheduler/bin/scheduler.ts` and their tests in line with AC-4 to
  AC-8 as well. No text marked `(maintainer answer, question #<id>)` changes
  anywhere, and no gate, bound, label rule or permission of specs 001 and 006
  changes.
- AC-12. **The suite passes.** Given the change, when `pnpm test` runs from
  the repository root and `pnpm -F @panelator/scheduler typecheck` runs, then
  both pass, including every spec 015 and spec 045 test in
  `test/loop.test.ts` and `test/e2e.test.ts`.

## 4. Interfaces and files

The marks the spec PR writes (AC-10), each prepended as spec 039 says:

| Spec and unit | Clause of the mark |
|---|---|
| 022 AC-3 | at cap 0 the check makes no cost call and exits 0 on a matching identity (AC-7) |
| 022 AC-4 | while the cap is 0 the scheduled pull is skipped and only the identity check runs (AC-6 for a forced pull) (AC-5) |
| 022 AC-9 | the alarm is the third `infra_alarm` producer, after the outage alarms of specs 015 and 045, and subscribers branch on `kind` (AC-3) |
| 022 AC-10 | at cap 0 the tick field and the `aws` command show the skipped pull (AC-8) |
| 022 section 4, "`infra_alarm`, not a new event." | the event already has the outage producers of specs 015 and 045, and every payload carries a `kind` (AC-3) |
| 022 section 6 (block quote under the heading) | at cap 0 the post-deploy write-up records the identity check and the skipped pull (AC-9) |
| 022 section 8, "2. Give the pipeline least-privilege access." | the policy grants `sts:GetCallerIdentity` and `ce:GetCostAndUsage` only, as AC-4 prints it |
| 015 AC-8 | the `infra_alarm` payload gains `kind: "network_outage"` (AC-1) |
| 045 AC-5 | the `infra_alarm` payload gains `kind: "network_outage"` (AC-2) |
| 030 AC-15 | the outage alarm is the payload of kind `network_outage`, and a payload without `kind` is filed as unknown (AC-3) |

The implementation PR of this spec edits:

- `tools/scheduler/src/service/loop.ts`: the `infra_alarm` emit in the outage
  alarm (line 317 on `main`) passes `{ kind: "network_outage", issue, since,
  failures: count, cause }` (AC-1).
- `tools/scheduler/src/standing/run.ts`: the `infra_alarm` emit in the outage
  alarm (line 138 on `main`) passes `{ kind: 'network_outage', agent:
  def.name, since, failures: count, cause }` (AC-2).
- `tools/scheduler/test/loop.test.ts` and `tools/scheduler/test/e2e.test.ts`:
  the two assertions of AC-11.
- When AC-11's condition holds, also `tools/scheduler/src/aws/`,
  `tools/scheduler/bin/scheduler.ts` and `tools/scheduler/test/aws.test.ts`.

The interfaces spec 022's implementation builds for AC-4 to AC-8: the
service-log kinds `aws-pull-skipped` and `aws-pull-resumed`; the field
`pull_skipped` in the tick's `aws` field and in `panelator-scheduler aws
--json`; the identity check's last time kept in memory beside the on/off
state in `src/aws/identity.ts`; no new file in the state directory and no
new event-store kind.

The spec PR adds this file, lists it under `## Children` in
`docs/delivery-system-design.md`, and writes the marks above.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The change
adds one field to two event payloads; it touches no gate, bound, label rule,
permission or token handling, and narrows the AWS permission the maintainer
grants. This spec plans no change to the charter, to a protected maintainer
decision, to the sensitive-path list, to the security review criteria or
instructions, or to what decides that a sensitive diff gets the security
review, that both reviews must approve, or that a sensitive path must be
listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-12).
- `grep -rn "'infra_alarm'\|\"infra_alarm\"" tools/scheduler/src` shows every
  emit with a `kind` in its payload (AC-1 to AC-3).
- `grep -rn "GetCostForecast\|get-cost-forecast" specs/050-infra-alarm-kind-and-aws-cap-zero tools/scheduler/src`
  matches only this spec's prose (AC-4).
- `grep -n "Amended by \[050-infra-alarm-kind-and-aws-cap-zero\]" specs/*/spec.md`
  lists the ten marks of section 4, and `git diff main -- specs/015-chain-keeps-its-work specs/022-delivery-aws-account specs/030-beyond-github specs/045-standing-agent-waits-out-network-outage`
  shows only added mark text (AC-10).
- For spec 022's implementation (AC-5 to AC-8), recorded runs with the fake
  `aws` command: the cap 0 and a pull due, one identity call and no cost call,
  no `cost.json`, one `aws-pull-skipped` line, the tick field with
  `pull_skipped`; a second interval with the cap still 0, one more identity
  call and no second skip line; `param set aws_cap_usd 5`, then the next tick
  pulls and logs `aws-pull-resumed`; `aws-check` at cap 0 exiting 0 with no
  cost call; `aws pull` at cap 0 making one cost call with its warning.
- Live check after deploy: the next outage alarm's `infra_alarm` payload in a
  subscriber's `pending_events` (once infra health subscribes) carries
  `kind: "network_outage"`.

## 6. Open decisions

None.
