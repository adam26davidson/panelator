# 035. One exact pnpm version, and `pnpm test` installs first under any pnpm

Status: written 2026-11-06 from the delivery-system design for issue #56;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (the chain has no human stops, so a stage's
`pnpm test` must not fail for a reason unrelated to the change);
[ADR 0008](../../docs/decisions/0008-pnpm-pinned-exact-and-install-before-run.md)
(pin one exact version in `packageManager` and make the install part of
running a script, rather than a scheduler install step);
[010-approve-esbuild-build](../010-approve-esbuild-build/spec.md) section 1
(records the two pnpm versions and their behaviours) and section 2 (which
left pinning and install-before-run out of scope; this spec does them);
[001-scheduler-core](../001-scheduler-core/spec.md) section 16 (`pnpm test`
is the suite every stage runs).

## 1. Goal

Every place that runs the repository's scripts runs the same pnpm, and a
fresh checkout's first `pnpm test` installs the dependencies and runs the
suite whichever pnpm is on `PATH`. After this spec, `package.json` names one
exact pnpm version, the CI job reads it from there, the laptop's pnpm
switches to it on its own, and `pnpm-workspace.yaml` says that a script
installs a missing or stale `node_modules` before it runs. The stage
prompts keep saying "run `pnpm test`" and no longer depend on which pnpm
major happens to be installed.

### What is wrong today (spec agent's investigation, reproduced 2026-11-06)

- `package.json` line 5 says `packageManager: "pnpm@10"`. pnpm's version
  management switches only to an exact version, so the field does nothing:
  the laptop's global pnpm 12.8.1 runs in every scheduler worktree
  (`pnpm --version` at the repository root prints `12.8.1`), and pnpm 10
  prints `WARN Cannot switch to pnpm@10: "10" is not a valid version` on
  every command.
- `.github/workflows/ci.yml` tells `pnpm/action-setup@v4` `version: 10`,
  which resolves the newest 10.x (10.34.9 today). The action reads
  `packageManager` when `version:` is absent, and fails with
  `Multiple versions of pnpm specified` when both are present and differ,
  so an exact pin and the `version:` input cannot coexist.
- pnpm 12 checks `node_modules` before every `pnpm run` and installs when it
  is missing or stale (`verifyDepsBeforeRun`, default `install` in 12);
  pnpm 10's default is `false`. The scheduler never installs in a worktree
  it creates (`tools/scheduler/src/runner/worktree.ts` `ensureWorktree`,
  `tools/scheduler/src/standing/run.ts` for a standing agent's detached
  worktree), and the stage prompts (`agents/stages/implement.md`,
  `agents/stages/fix.md`, `agents/profiles/backend/instructions.md`) say
  only "run `pnpm test` from the repo root". In a fresh clone of `main` with
  no `node_modules`, `pnpm test` under pnpm 10.34.9 prints
  `sh: vitest: command not found` and exits 1; under pnpm 12 the same
  command installs 276 packages and passes. Aligning the laptop to the
  declared major today would therefore fail every fresh-worktree stage.
- With `verifyDepsBeforeRun: install` added to `pnpm-workspace.yaml`, the
  same fresh clone under pnpm 10.34.9 installs (esbuild's and the Chromium
  package's approved builds run), runs the suite and exits 0; the second
  `pnpm test` skips the install; `git status` shows only the edited
  workspace file. In a directory whose `package.json` says
  `packageManager: "pnpm@10.34.9"`, the laptop's pnpm 12 prints `10.34.9`
  for `pnpm --version`: the switch works across majors.

## 2. Out of scope

- Moving the repository to pnpm 12 (or any other major). The pin keeps the
  major CI has tested every PR against; a major bump is a dependency change
  with its own PR, where the pinned field is the one line to edit.
- A `pnpm install` step in the scheduler (`ensureWorktree`, the standing
  agent's worktree setup, or before a stage). ADR 0008 records why the
  install belongs to the script.
- The CI job's explicit `pnpm install --frozen-lockfile` and its Chromium
  install step: unchanged. Only the `pnpm/action-setup` step changes.
- The stage prompts and profile instructions under `agents/`: unchanged.
  They say "run `pnpm test`" and after this spec that is enough under any
  pnpm.
- A `+sha256` integrity suffix on the `packageManager` value, Node's
  corepack, and the Node version (both sides run Node 26 already).
- The build-script approvals and the catalog of `pnpm-workspace.yaml`
  (spec 010 and design-tree R5.Q4): unchanged.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

- AC-1. **One exact version, declared once.** Given `package.json`, when its
  `packageManager` field is read, then it matches `^pnpm@10\.\d+\.\d+$` (an
  exact 10.x version, the newest 10.x release at the time the change lands;
  10.34.9 on 2026-11-06). Given `.github/workflows/ci.yml`, when its steps
  are read, then the step whose `uses` starts with `pnpm/action-setup` has
  no `with.version` (and no `with` at all is fine), so the action reads the
  version from `packageManager`.
- AC-2. **The laptop's pnpm runs the pinned version.** Given the repository
  root and a pnpm of a different version on `PATH` (the laptop's 12.8.1),
  when `pnpm --version` is run there, then it prints the exact version
  named in `packageManager`, and no `Cannot switch` warning is printed.
- AC-3. **A script installs first, under any pnpm.** Given
  `pnpm-workspace.yaml`, when it is parsed, then `verifyDepsBeforeRun` is
  the string `install`. Given a checkout with no `node_modules` directory
  anywhere in the workspace, when `pnpm test` is run once from the
  repository root under the pinned pnpm 10.x, then pnpm installs the
  dependencies (the output shows `Packages: +<n>` and esbuild's
  `postinstall: Done` before `vitest run`), runs the suite and exits 0.
  Given the same with the laptop's pnpm 12 on `PATH`, then the result is
  the same (pnpm 12 switches to the pinned version first, AC-2).
- AC-4. **A second run does not install.** Given AC-3 has run once, when
  `pnpm test` is run again, then no `Packages: +` line is printed and the
  suite runs and exits 0.
- AC-5. **The install is deterministic and leaves tracked files alone.**
  Given either install of AC-3, when `git status --short` is checked, then
  it is empty: `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `package.json`
  are as committed.
- AC-6. **CI runs the pinned version.** Given the implementation PR, when
  the `ci` workflow runs, then its `pnpm/action-setup` step installs the
  exact version named in `packageManager`, `pnpm install --frozen-lockfile`
  and `pnpm test` pass, and the job does not fail with
  `Multiple versions of pnpm specified`.
- AC-7. **The pin and the setting are guarded by a test.** Given
  `pnpm test` from the repository root, then a test reads the root
  `package.json`, `pnpm-workspace.yaml` and `.github/workflows/ci.yml`
  relative to the test file and asserts AC-1 and the first sentence of
  AC-3; the test fails on `main` before the change (the field is `pnpm@10`,
  the workflow sets `version: 10`, the setting is absent) and passes after.
- AC-8. **The landed text follows.** Given the implementation PR's diff,
  then the three bullets of spec 010 section 2 that leave pinning,
  pnpm 10's install-before-run and a scheduler install step out of scope
  each carry a note that spec 035 did (or, for the scheduler step, decided
  against) it. No other line of spec 010 changes, and no text marked
  `(maintainer answer, question #<id>)` changes anywhere.

## 4. Amendments to earlier specs

- **Spec 010 section 2.** The bullet "Pinning `packageManager` to an exact
  pnpm version ..." gains "(done by spec 035)"; the bullet "Making pnpm 10
  install before a script as pnpm 12 does (`verifyDepsBeforeRun`) ..." gains
  "(done by spec 035)"; the bullet "Having the scheduler run `pnpm install`
  itself before a stage starts" gains "(decided against by ADR 0008; the
  script installs, spec 035)". The bullets stay, as the record of what
  spec 010 left alone.

## 5. Interfaces and files

- `package.json`: `packageManager` becomes `pnpm@<exact 10.x>`, the newest
  10.x published when the implementation lands (`npm view pnpm@10 version`
  names it; 10.34.9 on 2026-11-06). Nothing else in the file changes.
- `.github/workflows/ci.yml`: the `pnpm/action-setup@v4` step loses its
  `with: { version: 10 }`. The `actions/setup-node` step (Node 26,
  `cache: pnpm`), the frozen install, the Chromium install, `pnpm test` and
  the typecheck step are unchanged. The action reads `packageManager` from
  the checked-out `package.json`, which `actions/checkout` has already run
  for.
- `pnpm-workspace.yaml`: gains the top-level line
  `verifyDepsBeforeRun: install`, with a one-line comment that it makes
  `pnpm test` in a fresh worktree install first under any pnpm (spec 035).
  `packages`, `allowBuilds`, `catalog` and `minimumReleaseAgeExclude` are
  unchanged. Note for implementers: when a stage changes `package.json`
  without updating the lockfile, the install this setting runs fails (a
  stage runs with `CI=true`, so pnpm's install is frozen) and pnpm then
  runs the script anyway, which fails on the missing dependency; the stage
  fixes the lockfile (`pnpm add`, or `pnpm install --no-frozen-lockfile`)
  as it would have had to anyway. No text in the prompts changes for this.
- `tools/scheduler/test/workspace-config.test.ts`: gains the AC-7 tests.
  The file already reads `pnpm-workspace.yaml` with the scheduler's `yaml`
  dependency; the new tests read `package.json` (JSON) and
  `.github/workflows/ci.yml` (YAML) the same way, located relative to the
  test file, and assert: `packageManager` matches `^pnpm@10\.\d+\.\d+$`;
  the workflow's `jobs.test.steps` contains exactly one step whose `uses`
  starts with `pnpm/action-setup`, and that step has no `with.version`;
  `verifyDepsBeforeRun === "install"`. The existing build-approval and
  catalog tests are unchanged.
- `specs/010-approve-esbuild-build/spec.md` section 2: the amendments of
  section 4 (AC-8).

The spec PR itself adds `specs/035-pnpm-pinned-and-install-before-run/spec.md`
and `docs/decisions/0008-pnpm-pinned-exact-and-install-before-run.md`, and
lists this spec under `## Children` in `docs/delivery-system-design.md`.

`package.json`, `pnpm-workspace.yaml`, `.github/` and `tools/scheduler/`
are sensitive paths (`agents/sensitive-paths.txt`: the test wiring, the CI
workflow and the scheduler), so the implementation PR gets the security
review (spec 006 AC-9). The change does not drop, skip or narrow what
`pnpm test` runs: it fixes which pnpm runs it and adds an install before
the suite when `node_modules` is missing or stale. This spec plans no
change to the charter, to a protected maintainer decision, to the
sensitive-path list, to the security review criteria, or to what routes a
sensitive diff to the security review.

## 6. Verification

- AC-1, AC-3 (first sentence), AC-7: `pnpm test` from the repository root
  passes, including the new tests; the new tests fail when run against
  `main`'s `package.json`, `ci.yml` and `pnpm-workspace.yaml`.
  `pnpm -F @panelator/scheduler typecheck` is clean.
- AC-2: at the repository root with the laptop's pnpm 12 on `PATH`,
  `pnpm --version` prints the pinned version; `pnpm --version` in a
  directory outside the repository still prints `12.8.1`.
- AC-3, AC-4, AC-5: in a fresh clone (or after
  `rm -rf node_modules tools/*/node_modules web/node_modules sdk/assemblyscript/node_modules`),
  run `pnpm test` twice from the repository root with the laptop's pnpm on
  `PATH`, and once more from a fresh clone with `npx -y pnpm@<pinned> test`:
  the first run of each shows `Packages: +<n>` and `esbuild postinstall: Done`
  before the vitest summary and exits 0, the second shows no `Packages: +`
  line and exits 0, and `git status --short` is empty after each.
- AC-6: the `ci` workflow passes on the implementation PR, and its
  `pnpm/action-setup` step's log names the pinned version.
- AC-8: `git diff main -- specs/010-approve-esbuild-build/spec.md` shows
  only the three amended bullets of section 4.
- Live check after deploy: the first stage of the next issue the scheduler
  claims runs `pnpm test` in its fresh worktree and its run log shows the
  install (`Packages: +`) followed by a passing suite, under the pinned
  version (`Done in ... using pnpm v10.x`).

## 7. Open decisions

None.
