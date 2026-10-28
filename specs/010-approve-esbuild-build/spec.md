# 010. A fresh worktree's first `pnpm test` runs cleanly

Status: written 2026-10-28 from the delivery-system design for issue #12;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops, so a stage must not report a false
test failure) and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design); [001-scheduler-core](../001-scheduler-core/spec.md)
section 16 (`pnpm test` is the suite every stage runs).

## 1. Goal

The root `pnpm test` in a worktree that has never installed its dependencies
fails on its first run and passes on its second. Every stage that runs tests
in a new scheduler worktree pays one wasted run, and a stage that does not
retry reports a false failure. After this spec, the first `pnpm test` in a
fresh worktree installs the dependencies, runs the suite and passes, under
the pnpm the laptop runs and under the pnpm the CI job runs, with no
interactive prompt and no change to tracked files.

### What happens today (spec agent's investigation, reproduced 2026-10-28)

The lockfile contains `esbuild@0.28.2` (a dependency of vitest), which has a
`postinstall` script. pnpm 10 and later do not run a dependency's build
scripts unless the workspace allows them. The two versions in play differ in
what they do when a build is not allowed:

- **pnpm 12.8.1 (the laptop, so every scheduler worktree).** Running
  `pnpm test` without a `node_modules` directory installs first; that install
  stops with `ERR_PNPM_IGNORED_BUILDS ... Ignored build scripts:
  esbuild@0.28.2` and exits 1 before vitest starts. `node_modules` has been
  created by then, so the second `pnpm test` finds its dependencies in place
  and passes.
- **pnpm 10.34.9 (CI: `pnpm/action-setup` with `version: 10`).**
  `pnpm install --frozen-lockfile` prints a boxed warning with the same text
  and exits 0, which is why the CI job passes today.

Both versions accept the approval that pnpm 12's own `pnpm approve-builds
esbuild` writes to `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
```

With that entry, a fresh `pnpm test` under pnpm 12 and a fresh
`pnpm install --frozen-lockfile` then `pnpm test` under pnpm 10 both run
esbuild's `postinstall`, run the suite and pass, and `pnpm-lock.yaml` is
unchanged. The older key `onlyBuiltDependencies: [esbuild]` is read by
pnpm 12 (`pnpm config get` shows it) but does not stop the error, so it is
not the fix. *(agent's call: approve esbuild's build rather than ignore it.
Ignoring it, or disabling the check for all packages, would also silence
the error; approving exactly the one package that pnpm names keeps the
default protection for every other dependency, matches what pnpm's own
command writes, and lets esbuild's postinstall do its documented job of
validating the platform binary.)*

## 2. Out of scope

- Pinning `packageManager` to an exact pnpm version, so that pnpm's version
  management makes the laptop run the same pnpm as CI. The laptop and CI
  run different major versions today and this spec makes the first run pass
  on both; aligning them is separate work.
- Making pnpm 10 install before a script as pnpm 12 does
  (`verifyDepsBeforeRun`). CI installs explicitly; the laptop runs pnpm 12.
- Having the scheduler run `pnpm install` itself before a stage starts.
- Changing the CI workflow, the vitest configuration, or the esbuild or
  vitest versions.
- Approving, or ignoring, any package other than esbuild.

## 3. Acceptance criteria

AC-1. Given a checkout of the repository with no `node_modules` directory
anywhere in the workspace, and pnpm 12 (the laptop's version), when
`pnpm test` is run once from the repository root, then the install
completes without `ERR_PNPM_IGNORED_BUILDS`, esbuild's `postinstall` runs,
vitest runs the suite and the command exits 0.

AC-2. Given the same fresh checkout and the latest pnpm 10 (the CI job's
version), when `pnpm install --frozen-lockfile` and then `pnpm test` are run
from the repository root, then the install prints no "Ignored build
scripts" warning, esbuild's `postinstall` runs, and both commands exit 0.

AC-3. Given either install of AC-1 or AC-2 has run, when `git status` is
checked, then no tracked file has changed: in particular `pnpm-lock.yaml`
and `pnpm-workspace.yaml` are as committed, so the install is deterministic
and a stage's scope check sees nothing it did not expect.

AC-4. Given `pnpm-workspace.yaml`, when it is parsed, then its `allowBuilds`
map contains exactly one entry, `esbuild: true`, and the file sets no other
build-script setting (no `onlyBuiltDependencies`, `neverBuiltDependencies`,
`ignoredBuiltDependencies`, `strictDepBuilds` or
`dangerouslyAllowAllBuilds`), so the approval covers esbuild alone and
pnpm's default protection stays in force for every other dependency.

## 4. Interfaces and files

- `pnpm-workspace.yaml`: gains the `allowBuilds` map of section 1 with the
  single entry `esbuild: true`. The `packages` list is unchanged.
- `tools/scheduler/test/workspace-config.test.ts`: a test for AC-4 that
  reads the root `pnpm-workspace.yaml` (located relative to the test file)
  with the scheduler's existing `yaml` dependency and asserts the
  `allowBuilds` map and the absence of the other build-script keys. It is
  a guard against the approval being removed or broadened later, which CI
  under pnpm 10 would not catch because there the missing approval is only
  a warning.

No other file is created or modified. The workspace config and the
scheduler package are sensitive paths (the test wiring and the scheduler,
as the sensitive-path list records), so the implementation PR gets the
security review; the change adds one build-script approval and one test,
and does not drop, skip or narrow what pnpm test runs. This spec plans no
change to the charter, to a protected maintainer decision, to the
sensitive-path list, to the security review criteria, or to what routes a
sensitive diff to the security review.

## 5. Verification

- AC-1: in a fresh clone or worktree (or after `rm -rf node_modules
  tools/scheduler/node_modules`) with pnpm 12 on `PATH`, a single
  `pnpm test` from the repository root exits 0 and its output shows
  `esbuild postinstall: Done` followed by the vitest summary.
- AC-2: in a fresh tree, `npx -y pnpm@10 install --frozen-lockfile` prints
  no warning box and runs the postinstall, and `npx -y pnpm@10 test` exits 0.
  The CI job (`pnpm/action-setup` version 10, `pnpm install
  --frozen-lockfile`, `pnpm test`) passes on the PR.
- AC-3: `git status --short` is empty after each of the above.
- AC-4: `pnpm test` from the repository root passes, including the new
  test, and `pnpm -F @panelator/scheduler typecheck` is clean.

## 6. Open decisions

None.
