# 0009. A spec PR marks the text of an earlier spec it supersedes

Status: accepted
Date: 2026-11-06
Amends: [specs/006-no-human-stops](../../specs/006-no-human-stops/spec.md)
AC-21 (the spec PR's scope: the list of paths the scope check allows)
Decided by: the spec stage of issue #60 (an agent's call: a small, reversible
technical decision about the system's own rules, delivery-system design
section 3 and process-spec 4.2 step 3); carried by
[specs/039-spec-pr-marks-superseded-text](../../specs/039-spec-pr-marks-superseded-text/spec.md)

## Context

Spec 006 AC-21 holds a spec PR to the spec's own directory, `docs/designs/`,
`docs/decisions/` and the `## Children` section of its parent design
(`tools/scheduler/src/gates/spec-scope.ts`). When a new spec changes
behaviour that an acceptance criterion of a landed spec describes, the spec
PR cannot touch that criterion. The system has handled this three ways:

- **A reading in the new spec.** Spec 009 records its reading of spec 001
  AC-25 in its section 4; spec 011 section 4 records readings of spec 006
  AC-13, AC-15 and AC-21 and of spec 005 AC-2. The earlier text is unchanged
  and reads as current to anyone who opens the earlier spec first.
- **Text edits carried by the implementation PR.** Spec 013's
  implementation appended "(Amended by spec 013 and ADR 0003: ...)" to spec
  001 AC-25; spec 034 listed spec 001 section 11 and spec 009 section 2 in
  its files so its implementation PR could edit them. This works because the
  implement-track scope gate allows whatever the spec lists, but it puts a
  text decision of the spec stage in front of a reviewer judging code.
- **A sweep issue.** Issue #32 (spec 021) added a superseded note to spec
  001 section 7 that spec 008 had announced but not written; spec 032
  corrected spec 008's own section 5. Each sweep is a full chain run for a
  few lines of text.

The findings filer asked whether the scope rule or the reading convention
should change, with three options: widen the gate so the spec PR marks the
superseded text; keep the convention and sweep stale text by issues; or
keep the convention and have the reflection agents of spec 028 mark stale
criteria once they run.

## Decision

Widen the spec-track scope: a spec PR may also edit the `spec.md` of another
spec that the new spec links to, and every such edit is a mark that points
at the new spec. The earlier text stays in place as the record of what was
asked and built; the mark is prepended to it. Two mark forms, both already
in use in the specs:

- `Superseded by [NNN-slug](../NNN-slug/spec.md) AC-k:` when the criterion,
  paragraph or section no longer applies and AC-k (or `section k`) of the
  new spec says what applies instead;
- `Amended by [NNN-slug](../NNN-slug/spec.md) AC-k: <one clause>.` when it
  still applies as changed by that clause.

The gate allows only `specs/<other>/spec.md`, only when the new spec's text
links to that file, and never a spec's `plans/`, `design/` or `README.md`.
The spec review's scope criterion checks that each such edit is a mark in
one of the two forms, with the earlier text kept. The charter rule, the
top-design rules and the sensitive-path routing of the spec track are
unchanged: a mark in spec 001 or spec 006 still gets the security review.
An implementation PR may still carry marks its spec lists, as spec 034's
did. Spec 039 carries the gate change, the criteria, and the marks for the
readings specs 009 and 011 recorded.

## Reasons

- **The supersession is decided in the spec stage, so the mark belongs in
  the spec PR.** The spec reviewer reads the new spec against the earlier
  one and can judge whether a mark says the right thing; the implement
  reviewer judges code against the spec; a sweep chain re-derives what the
  spec stage knew when it wrote the reading. The pointer is cheapest where
  the knowledge is.
- **The gate's purpose is kept.** AC-21's scope stops a spec PR from
  changing behaviour the spec does not own. A mark that leaves the earlier
  text in place and names the spec that replaces it changes no behaviour;
  it makes a relation explicit that the status line already states in
  prose ("amends 001-scheduler-core section 3"). Requiring the link is a
  deterministic, one-line check, and the review judges the content, as it
  does for the rest of the spec PR.
- **The earlier text stays as the record.** Replacing a criterion with a
  one-line pointer (the filer's option as worded) would lose what the
  earlier spec asked for and what its implementation was built and reviewed
  against. Spec 021 AC-2 and the hand-made "Superseded by spec 006:" marks
  in spec 001 chose to keep the text, and the marks here follow them.
- **Only `spec.md`, only when linked.** `plans/` and `design/` belong to the
  implementation chain and the design stage; a `README.md` beside a missing
  `spec.md` is a split pointer. A spec that needs more than a mark to change
  an earlier spec is changing behaviour that spec owns; that goes into the
  new spec's own criteria, and the mark points there.
- **The other options leave stale text current.** A sweep rule costs a
  chain run per stale criterion and the text stays wrong until it runs. The
  reflection agents of spec 028 flag staleness that follows a design change
  (design section 10), not a sibling spec amending a criterion, and the fix
  would wait on them for no gain.
