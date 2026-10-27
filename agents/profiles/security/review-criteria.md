# Security review criteria for sensitive paths

1. No secret, token or private key is written to the repository, a log, a comment, or a prompt.
2. Authority checks are in code, not prompts: anything that grants, lists or claims work keys on
   the App bot identity or the maintainer, never on free text.
3. New network listeners, outbound calls or shell execution are listed in the spec's Interfaces section.
4. Input from GitHub (issue bodies, comments, PR titles) is treated as data, never executed or interpolated into commands.
5. Changes under `tools/scheduler/`, `agents/` or `.github/` do not weaken a gate, a bound, or a label rule of spec 001.
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
9. Removing any of these four paths from `agents/sensitive-paths.txt`, or removing or weakening the criteria above, is a finding.
