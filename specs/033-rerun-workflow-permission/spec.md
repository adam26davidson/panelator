# 032. The App's `actions` permission matches the `rerun_workflow` action

Status: draft 2026-11-05 from the delivery-system design for issue #53;
specs derived from that design need no maintainer approval (design section
11). Awaiting the maintainer's answer to a capability question (design
section 3, item 3): whether the installed GitHub App is granted `actions:
write`, which the `rerun_workflow` action of spec 008 needs and spec 001
section 12 does not grant. The acceptance criteria below are written for the
recommended answer (grant); the spec stage rewrites them in `record` mode if
the answer differs, and records the answer as an ADR under `docs/decisions/`
either way (process-spec 4.2 step 3).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.2 ("Act directly ... rerun a job" is a level-1 action; every direct
action is recorded with its undo), section 3 item 3 (credentials and access
are the maintainer's) and section 8 ("Credentials": a request names the
exact access needed and gives step-by-step setup; least privilege);
[008-agent-registry](../008-agent-registry/spec.md) AC-8 (the
`rerun_workflow` kind: re-run one workflow run of this repository, undo
cancels it) and AC-9 (the action log and its `failed` status);
[001-scheduler-core](../001-scheduler-core/spec.md) section 12 (the App's
permission list, the record of what the installed App may do);
[030-beyond-github](../030-beyond-github/spec.md) AC-2 (the credential
catalogue's `github-app-key` entry lists the App permissions of spec 001
section 12).

## 1. Goal

The App permission list in spec 001 section 12 and the direct actions of spec
008 agree: every GitHub call an action kind makes is covered by a permission
the list grants, so a `rerun_workflow` request that passes its checks is
applied, not refused by GitHub.

### What is wrong today

Spec 008 AC-8 ships the kind `rerun_workflow { run_id }`, whose code
(`tools/scheduler/src/actions/rerun-workflow.ts`) calls
`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`, and whose undo
calls `.../runs/{run_id}/cancel` (`tools/scheduler/src/github/client.ts`,
`rerunWorkflowRun` and `cancelWorkflowRun`). Both endpoints need the
repository permission `actions: write` on the App's installation token.
Spec 001 section 12 grants `checks and actions (read)`, and spec 008 amended
nothing in that list. With the token the scheduler mints today, GitHub
answers 403 to both calls, the request's error settles the log line as
`failed` (spec 008 AC-9; `tools/scheduler/src/actions/index.ts`), and the
undo the entry promises can never run either.

No standing agent lists the kind yet (`agents/standing/*.md` all carry
`actions: []`), so the live action log holds no `rerun_workflow` entry and
no 403 has been observed; the first agent to be given the kind (the infra
health agent, design section 6.1 and issue #124, whose brief includes
re-running a job after a CI failure on `main`) would hit it on its first
request. The kind is dead on arrival until the permission list and the
installed App change together.

### The fix

Granting the permission is the maintainer's action, outside any PR (design
section 3 item 3), and is requested as a capability question with this spec.
Once granted, this spec's implementation records the grant where readers
look for it and proves the kind works end to end:

- spec 001 section 12 lists `actions (write)` with the reason, in the way
  commit 3fa5c69 recorded the `workflows (write)` grant;
- the kind's entry in `agents/actions.yaml` names the permission it relies
  on, so the action audit and a future agent definition can see it;
- the implementation PR shows one real re-run and its cancel succeeding
  through the App's own token.

## 2. Out of scope

- Giving any standing agent the `rerun_workflow` kind: that is the agent's
  own spec (the infra health agent, issue #124). This spec only makes the
  kind usable.
- The other App permissions of spec 001 section 12, their scopes, and any
  permission a future action kind may need: each is its own request when it
  arises.
- The action kinds, levels, checks, log format and undo mechanics of spec
  008 AC-8 to AC-10, and the once-per-day limit on re-runs: unchanged.
- The capability-issue mechanics of spec 014 (markers, daily probe,
  automatic close): they belong to the findings filer's advisory path. Issue
  #53 is an ordinary issue; its question goes through the question check and
  pause of spec 006, and the answer resumes this spec stage.
- A probe that re-checks the permission on a schedule: a 403 on a real
  request is logged as `failed` (spec 008 AC-9) and the action audit reads
  the log; nothing more is built here.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are files on the PR branch or the repository's GitHub state;
"then" clauses are checked by reading them, by `pnpm test` where it says so,
and by the recorded commands of AC-3.

- AC-1. **Spec 001 section 12 records the grant.** Given
  `specs/001-scheduler-core/spec.md` section 12 after the change, then its
  permission list reads `checks (read), actions (write)` in place of `checks
  and actions (read)`, and the list is followed by one sentence stating that
  `actions (write)` serves the `rerun_workflow` action of spec 008 AC-8 (re-run
  and cancel a workflow run) and naming the ADR under `docs/decisions/` that
  records the maintainer's grant and its date. The diff of that file touches
  section 12 only.
- AC-2. **The kind names its permission.** Given `agents/actions.yaml`, then
  the `rerun_workflow` entry's `description` still states the once-per-day
  limit and adds that the kind needs the App's `actions: write` permission
  (spec 001 section 12). The registry test of spec 008 AC-1 (every kind in
  the file has code and every kind in code has an entry) still passes; no
  level changes.
- AC-3. **The grant is proven on a real run.** Given the implementation PR,
  then its description quotes, with HTTP status lines, one re-run request
  and one cancel request made through the App's `gh` wrapper (the token the
  scheduler mints, never a personal token) against a completed workflow run
  of the PR's own branch, in this order: `gh api -i -X POST
  /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` answering `201`, then
  `gh api -i -X POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel`
  answering `202`. Given either answers `403`, then the grant is not live:
  the PR is not opened, and the stage reports the status it saw so the
  question's answer can be checked. The scheduler itself is not run against
  the live repository for this proof.
- AC-4. **The credential catalogue agrees, when it exists.** Given
  `agents/credentials.yaml` (spec 030 AC-2) exists on `main` when this spec is
  implemented, then its `github-app-key` entry's `access` list includes
  `actions: write` beside the other permissions of spec 001 section 12. Given
  the file does not exist yet, then nothing is added here and spec 030's
  implementation copies the list from spec 001 section 12 as its AC-2 says.
- AC-5. **No maintainer decision and no enforcement changes.** Given the
  implementation PR's diff, then it changes no text marked `(maintainer
  answer, question #<id>)`, nothing under `tools/`, `.github/` or `schemas/`,
  no other file under `agents/`, and no gate, bound or label rule of specs
  001 and 006 (security criterion 5). The scheduler's code already makes the
  two calls; this spec changes what the App may do and what the specs say,
  not what the code does.
- AC-6. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate, the
  design-tree check and the registry test accept spec 001, spec 008,
  `agents/actions.yaml` and this spec.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly these
files:

- `specs/001-scheduler-core/spec.md`: section 12's permission list and the
  one sentence of AC-1.
- `agents/actions.yaml`: the `rerun_workflow` description (AC-2).
- `agents/credentials.yaml`: the `github-app-key` access list, only if the
  file exists on `main` (AC-4).

The spec PR itself adds `specs/032-rerun-workflow-permission/spec.md`, the
ADR under `docs/decisions/` that records the maintainer's answer (written in
`record` mode, carrying the `(maintainer answer, question #<id>)` mark), and
the `## Children` bullet in `docs/delivery-system-design.md`.

`specs/001-scheduler-core/spec.md` is a sensitive path (listed in
`agents/sensitive-paths.txt`), so the security review runs on the
implementation PR as spec 006 AC-9 says, and that path is listed here so the
scope gate accepts the diff. `agents/actions.yaml` is under `agents/`, which
is also sensitive. Nothing here changes the sensitive-path list, the
security criteria, or what routes a sensitive diff to the security review.
The permission the App gains lets its token re-run and cancel workflow runs,
and also delete runs, logs and artifacts, enable or disable workflows,
dispatch workflows and manage Actions caches; only the two calls of spec 008
AC-8 exist in the scheduler, every action is logged (AC-9) and audited
(spec 008's action audit agent), and any new use of the permission is
repository content that a reviewed PR has to add.

Suggested wording for spec 001 section 12 (the implementer may tighten it,
keeping AC-1's content):

> Permissions: issues (write), pull requests (write), contents (write),
> workflows (write), checks (read), actions (write), metadata (read),
> repository security advisories (write) for spec 004. `actions (write)`
> serves the `rerun_workflow` action of spec 008 AC-8 (re-run and cancel a
> workflow run); the maintainer granted it on <date> (ADR <number>).

## 5. Verification

- `pnpm test` from the repository root passes (AC-6).
- `git diff main -- specs/001-scheduler-core/spec.md` shows changes inside
  section 12 only (AC-1); `grep -n "actions (write)"
  specs/001-scheduler-core/spec.md` finds the list and the sentence.
- `git diff main -- agents/actions.yaml` shows one changed description (AC-2);
  `grep -n "actions: write" agents/actions.yaml` finds it.
- `git diff main --stat` lists no file other than those of section 4 (AC-5).
- The PR description carries the two quoted responses of AC-3, `201` then
  `202`, against a run id of the PR branch; `gh run view <run_id>` shows the
  run as cancelled afterwards.

## 6. Open decisions

None.
