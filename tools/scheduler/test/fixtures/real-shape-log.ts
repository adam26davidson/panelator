export const TS = "2026-11-01T08:32:02.5581118Z ";
export const ESC = "\u001b";

/** A failed `test` job's raw log in the shape of issue #39's. */
export function realShapeLog(passing = 150): string {
  const lines = [`${TS}##[group]Run pnpm test`, "", `${TS}${ESC}[1m${ESC}[7m${ESC}[36m RUN ${ESC}[39m${ESC}[27m${ESC}[22m v3`];
  for (let i = 0; i < passing; i++) lines.push(`${TS} ${ESC}[32m✓${ESC}[39m Scheduler.tick: passing test number ${i} ${ESC}[2m 3ms${ESC}[22m`);
  lines.push(
    `${TS}${ESC}[31m⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯${ESC}[39m`,
    `${TS} ${ESC}[41m FAIL ${ESC}[49m test/a.test.ts > Scheduler > does the thing`,
    `${TS}${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: expected 1 to be 2${ESC}[39m`,
    `${TS} ${ESC}[36m ❯ ${ESC}[39m test/a.test.ts:10:5`,
    `${TS}   Test Files  1 failed | 3 passed (4)`,
    `${TS}      Tests  1 failed | 30 passed (31)`,
    `${TS}   Duration  4.2s`,
    `${TS} ELIFECYCLE  Test failed. See above for more details.`,
    `${TS}##[error]Process completed with exit code 1.`,
    `${TS}Post job cleanup.`,
    `${TS}[command]/usr/bin/git config --local --name-only --get-regexp core.sshCommand`,
    `${TS}Cleaning up orphan processes`,
    `${TS}##[warning]Node.js 20 actions are deprecated.`,
    "",
  );
  return lines.join("\n");
}

