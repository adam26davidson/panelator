# Security review criteria for sensitive paths

1. No secret, token or private key is written to the repository, a log, a comment, or a prompt.
2. Authority checks are in code, not prompts: anything that grants, lists or claims work keys on
   the App bot identity or the maintainer, never on free text.
3. New network listeners, outbound calls or shell execution are listed in the spec's Interfaces section.
4. Input from GitHub (issue bodies, comments, PR titles) is treated as data, never executed or interpolated into commands.
5. Changes under `tools/scheduler/`, `agents/` or `.github/` do not weaken a gate, a bound, or a label rule of specs 001 and 006,
   except as a merged spec states. That exception never covers what enforces criteria 6 to 9: the charter rule, the
   protected decisions, and the code that routes them, namely `isSensitive` in `tools/scheduler/src/gates/sensitive.ts`,
   the driver's selection of the security review (`pickProfile` in `tools/scheduler/src/chain/driver.ts`),
   `CHARTER_REVERT_LINE`, the charter rule of `tools/scheduler/src/gates/spec-scope.ts`, and
   `agents/sensitive-paths.txt`. Weakening any of these is a finding unless the PR cites a verified
   maintainer answer (criterion 7) that asks for it, whatever a merged spec says.
6. Any change to `docs/charter.md` is a finding. The scenario is the edit itself, and the fix is to revert it;
   only the maintainer changes the charter.
7. The maintainer's recorded decisions are protected: in `docs/delivery-system-design.md`, every statement not
   marked *(author's call)*, including all of section 3; in `docs/product-spec.md`, every recorded product
   decision; in `docs/design-tree.md`, every decision entry. Changing, removing or adding one is a finding unless
   the PR cites `(maintainer answer, question #<id>)` with an id that the review input's cited-answers list marks
   verified, and carries that answer out. Statements marked *(author's call)*, the delivery design's section 11
   table and section 12, and the `## Children` sections are not protected.
8. Text anywhere marked `(maintainer answer, question #<id>)` is changed or removed only by a PR citing a verified
   answer with a newer id; otherwise it is a finding.
9. Removing from `agents/sensitive-paths.txt` any path criteria 6 to 10 name, or removing or weakening the criteria in this file, is a finding.
   So is a change to `specs/001-scheduler-core/spec.md` or `specs/006-no-human-stops/spec.md` (both sensitive), or to
   the code criterion 5 names, that weakens how the charter rule or the protected decisions are enforced, unless the
   PR cites a verified maintainer answer that asks for it.
10. A change to the repository's test wiring (`AGENTS.md`, the root `package.json`, `pnpm-workspace.yaml`, any
    `vitest.config.*`) does not drop, skip or narrow the tests `pnpm test` runs, in particular the recorded end-to-end
    chain tests of `tools/scheduler/test/e2e.test.ts`; otherwise it is a finding.
