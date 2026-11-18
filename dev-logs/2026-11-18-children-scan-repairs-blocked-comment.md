# 2026-11-18: the children scan completes a blocked comment it failed to post (issue #146, spec 078)

## What was built

- `fileDesignChildren` (`tools/scheduler/src/children/scan.ts`): in the unblock pass, an open child issue with
  `blocked`, no blocked or unblocked marker comment by the App and the App's child marker in its body gets the
  missing blocked comment when the latest `labeled` event for `blocked` has the App bot login as actor
  (`latestLabelActor`). The same pass then judges unblocking as spec 031 AC-6 says. The comment text is built by
  one function used by the filing and the repair. `ChildrenGh` gained `labelEvents`.
- `inDependencyOrder`'s doc comment names spec 078 AC-3 (the filing order was already the dependency order).
- Tests in `tools/scheduler/test/children.test.ts`: the fake client records `labeled` events and can fail `comment`.

## Choices

- A failing repair comment is logged as `child-filing-failed` (`blocked comment: ...`) and added to `errors`, but
  does not count toward the three-scan failure counter: the issue exists, so nothing is lost.
- `labelEvents` is read only for an issue meeting every other condition, so a scan with no missing comment makes
  no extra GitHub calls.

## To check after the merge

Spec 078 section 6 asks for the label timeline of one real issue the App filed with `blocked` to be read
(`gh api repos/{owner}/{repo}/issues/<n>/timeline`) to confirm its `labeled` event for `blocked` has the App bot
login as actor. This run had no such check made; it remains to be done after the merge.
