# Review criteria for spec PRs (spec 006 AC-21)

1. The spec fits its parent design: it does what the parent says this part of the system is for, and nothing the parent rules out.
2. The spec fits the issue body: it covers what the issue asks for, and nothing the issue does not.
3. The spec has the field set (status line with class, domain and derives-from links; goal; out of scope;
   numbered Given/When/Then acceptance criteria; interfaces and files; verification; UI design where the
   domain needs it; open decisions, empty) and a `Parent:` line, and the parent's `## Children` section lists it.
4. The spec decides no design section 3 question itself: no product decision (a big-picture choice about
   what panelator is and promises its users), no large technical decision with real uncertainty, and nothing
   only the maintainer can do. A large decision with one clearly right answer is fine, recorded as an ADR.
5. The PR edits nothing outside the allowed paths: the spec's directory, `docs/designs/`, `docs/decisions/`,
   the `## Children` section of the spec's parent design, the `spec.md` of a spec the new spec links to
   (spec 039), and the top designs only while recording a maintainer's product answer. Every change to
   another spec's `spec.md` is a mark: text prepended to the smallest unit it applies to (a criterion,
   after its `AC-n.` number and before its text or bold title; a titled paragraph inside a criterion,
   after its bold title; a section, as a block quote under its heading) that reads either
   `Superseded by [NNN-slug](../NNN-slug/spec.md) AC-k:` or
   `Amended by [NNN-slug](../NNN-slug/spec.md) AC-k: <one clause>.`, where `NNN-slug` is the new spec
   and `AC-k` (or `section k`) is where the new spec says what applies. The earlier text follows the
   mark unchanged, and the new spec's status line names the earlier spec and the units it marks. An edit
   that is not a mark, or a mark that names a spec other than the new one, is a finding under this criterion.
6. The PR changes or removes no text marked `(maintainer answer, question #<id>)` unless it cites an id that
   the review input's cited-answers list marks verified and that is newer than the marked one (AC-10, AC-18).
7. The spec plans no change to `docs/charter.md`, to a protected maintainer decision without a
   verified maintainer answer, or to how either is enforced: the sensitive paths, the security review
   criteria and instructions, and whatever decides that a sensitive diff gets the security review, that
   both reviews must approve, and that a sensitive path must be listed in the spec (security criterion 5
   names the current code). The protected decisions are those of security
   criterion 7; a verified answer is one the review input's cited-answers list marks verified.
8. When the PR adds or changes a design's `## Children`, the breakdown fits the design: every part of the
   design is covered by one child, no two children cover the same part, each planned child's brief is enough
   to write a spec from, and each `after:` is justified by the design.
