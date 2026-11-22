import { configDefaults, defineConfig } from "vitest/config";

const include = ["tools/**/*.test.ts", "web/**/*.test.ts"];
/**
 * Test files that read what the other files left behind, so they run in a second group, after every file of the first
 * has finished (`sequence.groupOrder`). The e2e chains are split over several files for parallelism (issue #360), and
 * e2e-event-kinds.test.ts checks the events all of them recorded.
 */
const afterTheRest = ["tools/scheduler/test/e2e-event-kinds.test.ts"];

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Files run in parallel, the tests within a file in order. Half the cores (vitest's default is all but one), since
    // two pipeline worktrees often run the suite at once and each test drives real git and node child processes.
    maxWorkers: "50%",
    projects: [
      {
        test: {
          name: "tests",
          include,
          exclude: [...configDefaults.exclude, ...afterTheRest],
          // Only here: the after group's workers inherit the TMPDIR this sets, so both groups share the run's root.
          globalSetup: ["tools/scheduler/test/helpers/test-tmpdir.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "after",
          include: afterTheRest,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
