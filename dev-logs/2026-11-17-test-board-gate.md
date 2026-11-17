# 2026-11-17: the test board gate and firmware promotion (issue #132, spec 070)

## What was built

- **Configuration.** The optional `firmware` block and `bounds.board_bricks` (`tools/scheduler/src/config.ts`),
  on in `agents/scheduler.yaml`; `firmware.soak_hours` and `firmware.promotion_enabled` in `agents/parameters.yaml`.
  The recorded end-to-end worlds switch it off unless a test asks for it, so every earlier recorded chain is unchanged.
- **The gate.** `firmware/gate.ts` reads the HIL check beside `required_checks` for a firmware PR's head: no workflow
  in the head is a block on the workflow path (spec 060's `paths` condition, with spec 070's finding); a bricked or
  absent result, or a board already down, is a `board` block with no finding, notice or `blocks` count; a bricked
  result from the PR's head counts against `bounds.board_bricks` and at the bound takes spec 006 AC-5's terminal
  step. A HIL check run is read once (`firmware/hil-read.json`), applied to `board.json` first, then recorded as a
  `hil.result` event. After the maintainer's `board back` the resume re-runs the bricked workflow run when the head
  did not change; a rebased head gets its own run.
- **Releases and promotion.** `firmware/releases.ts` lists releases at most every 600 s and follows the board's HIL
  results into `firmware/releases.json`; `firmware/promote.ts` evaluates the six criteria of AC-10 each tick and
  promotes at most one build. The tick line carries `board` and `firmware`.
- **Commands.** `board`, `board back`, `board bricked`, `firmware`, `firmware promote`, `firmware demote`; the four
  that change state are level-1 action kinds, maintainer only.

## What was not built

The firmware side (ADR 0013): the HIL workflow, the serial harness, the suite and the release workflow. There is no
firmware yet, so the first real HIL run, the first beta record and the first promotion are for the firmware work that
brings the workflow to write up here.

## A tick with firmware on, nothing to list, the board unknown

```json
{"at":"2026-11-17T19:34:52.334Z","kind":"tick","eligible":0,"claimed":[],"released":[],"held":0,"standing":[],"errors":[],"restartPending":false,"firmware":{"stable":null,"next":null},"board":{"status":"unknown","since":null},"active":[]}
```

## Notes

- A blocked record's condition test for `board` reads `board.json` at each tick, so the chain resumes in the same
  tick as the maintainer's `board back` is seen, or when a later HIL result sees an absent board.
- The commands run on the laptop without the service, so `board bricked` there prints its alert text on the terminal
  and writes it to the service log; no Telegram channel runs in that process.
