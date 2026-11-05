# 0006. The GitHub App is granted `actions: write` for the `rerun_workflow` action

Status: accepted
Date: 2026-11-05
Amends: [specs/001-scheduler-core](../../specs/001-scheduler-core/spec.md)
section 12 (the App's permission list: "checks and actions (read)")
Decided by: the maintainer, in answer to the capability question of issue
#53 *(maintainer answer, question #6660544631)*; carried by
[specs/033-rerun-workflow-permission](../../specs/033-rerun-workflow-permission/spec.md)

## Context

Spec 008 AC-8 ships the level-1 direct action `rerun_workflow { run_id }`,
which re-runs one GitHub Actions workflow run of this repository and whose
undo cancels it. The code calls `POST .../actions/runs/{run_id}/rerun` and
`.../cancel`. Both need the App repository permission `actions: write`.
Spec 001 section 12 granted `checks and actions (read)`, and spec 008
amended nothing in that list, so GitHub would answer 403 and the action
would be logged as `failed` (spec 008 AC-9) on every request. No standing
agent had the kind in its `actions` list yet, so the gap had not been hit;
the infra health agent (design section 6.1, issue #124) would have been the
first.

The delivery-system design names "rerun a job" as a level-1 action
(section 6.2). Changing the installed App's permissions is the maintainer's
alone (section 3, item 3), so the spec stage asked, with two options: grant
`actions: write`, or decline and withdraw the kind.

## Decision

The maintainer answered "Done" on 2026-11-05 *(maintainer answer, question
#6660544631)*: the App's repository permission Actions is set to read and
write and accepted on the installation.

- Spec 001 section 12 records `actions (write)`, serving the
  `rerun_workflow` action of spec 008 AC-8 (re-run and cancel a workflow
  run), with this ADR as its reason.
- The `rerun_workflow` kind stays at level 1 as spec 008 defines it. The
  permission is used by that kind's two calls only; any further use of
  `actions: write` is repository content and needs a reviewed PR.

## Consequences

- The App's installation token can also delete runs, logs and artifacts,
  enable or disable workflows, dispatch workflows and manage Actions caches.
  The scheduler makes none of those calls; every direct action is logged
  (spec 008 AC-9) and read by the action audit agent, and the security review
  checks changes under `agents/` and to spec 001.
- The infra health agent, when it is specified, may list `rerun_workflow`
  in its `actions` and re-run a failed run on `main` directly.
- Spec 033 records the grant in spec 001 section 12 and in
  `agents/actions.yaml`, and proves one real re-run and cancel through the
  App's token in its implementation PR.
