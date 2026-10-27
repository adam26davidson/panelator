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
   the `## Children` section of the spec's parent design, and the top designs only while recording a
   maintainer's product answer.
6. The PR changes or removes no text marked `(maintainer answer, question #<id>)` unless it cites an id that
   the review input's cited-answers list marks verified and that is newer than the marked one (AC-10, AC-18).
