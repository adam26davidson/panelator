# 0008. One exact pnpm version everywhere, and a script installs before it runs

Status: accepted
Date: 2026-11-06
Amends: [specs/010-approve-esbuild-build](../../specs/010-approve-esbuild-build/spec.md)
section 2 (which left pinning, install-before-run and a scheduler install
step out of scope)
Decided by: the spec stage of issue #56 (an agent's call: a decision with one
clearly right answer, delivery-system design section 3); carried by
[specs/035-pnpm-pinned-and-install-before-run](../../specs/035-pnpm-pinned-and-install-before-run/spec.md)

## Context

`package.json` declares `packageManager: pnpm@10`, a major with no minor or
patch. pnpm's own version management switches only to an exact version, so
the field changes nothing: the laptop, and with it every scheduler worktree,
runs the globally installed pnpm 12.8.1, while the CI job's
`pnpm/action-setup` step is told `version: 10` and runs the newest 10.x
(10.34.9 on 2026-11-06). pnpm 10 also warns on every run that `"10" is not
a valid version` to switch to.

The two majors differ in ways that have already cost a stage its run.
Issue #12 (spec 010) was an unapproved build script that pnpm 12 reports as
an error and pnpm 10 as a warning. The second difference is still open:
pnpm 12 checks `node_modules` before every `pnpm run` and installs when it
is missing or stale (`verifyDepsBeforeRun`, default `install` in 12), pnpm 10
does not (default `false`). The scheduler never runs `pnpm install` in a
worktree it creates, and the stage prompts (`agents/stages/implement.md`,
`agents/stages/fix.md`, the backend profile) say only "run `pnpm test`".
A fresh worktree's `pnpm test` works today solely because pnpm 12 installs
on the way. Reproduced on 2026-11-06 in a fresh clone of `main`: under
pnpm 10.34.9, `pnpm test` with no `node_modules` prints
`sh: vitest: command not found` and exits 1.

Issue #56 offers two fixes: pin an exact version in `packageManager` and
drop `version:` from the CI action, or keep the major and have the worktree
setup run an explicit frozen install before the first script.

## Decision

Both halves, each in its smallest form, and no scheduler install step:

1. `packageManager` names one exact pnpm version, the newest 10.x at the
   time the change lands, and the CI job's `pnpm/action-setup` step has no
   `version:` input, so it reads the same field. The laptop's pnpm 12
   switches to the pinned version on its own (confirmed: in a directory whose
   `package.json` says `pnpm@10.34.9`, the laptop's `pnpm --version` prints
   `10.34.9`).
2. `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: install`, so that
   `pnpm run` and `pnpm exec` install a missing or stale `node_modules`
   before the script, whichever pnpm runs them. The stage prompts keep
   saying "run `pnpm test`"; the setting is what makes that enough.

## Reasons

- **One version, declared in one place.** The repository already says 10
  twice (the `packageManager` major and the CI input); making the
  `packageManager` field exact and the only declaration removes the
  disagreement without choosing anything new. `pnpm/action-setup` reads the
  field when `version:` is absent and errors when both are given and differ,
  so the field cannot silently drift from CI again. Pinning to 10 rather
  than 12 keeps the version CI has tested every PR against; moving the
  major is a dependency bump with its own review, separate work.
- **The install belongs to the script, not to the scheduler.** A setting in
  the workspace file covers every runner of `pnpm test`: a stage in a fresh
  worktree, a standing agent's detached worktree, the maintainer at the
  laptop, a clone on another machine. A `pnpm install` step in
  `ensureWorktree` would cover only the scheduler's chains, would need pnpm
  on the service's path and a second run after every rebase that changes the
  lockfile, and would add a failure mode before any agent starts. CI keeps
  its explicit `pnpm install --frozen-lockfile`, which is unaffected.
- **Nothing observable changes on the laptop today.** pnpm 12 already
  installs before a script; the setting records that behaviour so that the
  pinned pnpm 10, or a future pnpm default, keeps it. Under the pinned
  version the esbuild and Chromium build approvals of spec 010 and the
  catalog are read as before (the fresh install under 10.34.9 ran both
  postinstalls and the whole suite passed).
- **Not a maintainer decision.** Which pnpm runs the test suite is a
  tooling detail that keeps every promise the product and the delivery
  system make; the charter, the sensitive-path list, the review criteria
  and what `pnpm test` runs are untouched. The implementation touches
  sensitive paths (`package.json`, `pnpm-workspace.yaml`, `.github/`,
  `tools/scheduler/`) and gets the security review as usual.
