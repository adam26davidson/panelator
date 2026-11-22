# Review criteria for widget implementation PRs (spec 109 AC-3)

Read the spec and `docs/widget-abi.md`, then the diff's sources, tests and
golden frames (the PNGs, with Read), and the spec's merged `design/` renders
when it has them. You have no shell: you build and run nothing, and a test
run or frame the PR description quotes is a claim, not evidence. Judge from
what you can read, and name what you could not judge in `declined_to_judge`.

1. ABI: every module imports only what `docs/widget-abi.md` lists, from the
   module it names, and exports exactly what it requires, with the ABI
   version it declares; a change to the document, the SDK's bindings or a
   host's import table is one the spec makes, with the version moved by the
   document's rule.
2. Golden frames: a PNG under `sdk/conformance/golden/` changes only where
   the spec changes what the frame shows, its hash in `frames.json` changes
   with it, and no script, test or workflow sets `PANELATOR_BLESS`. Open
   each changed frame and check it shows what the spec says.
3. Design: when the spec has a merged `design/`, the golden frames show what
   its renders show for each widget and scene.
4. Determinism: a frame depends only on what the host provides (time,
   timezone, config, data, the random sequence), so the same module gives
   the same frames in every host.
5. Rust: the SDK and the widgets are `no_std`; every `unsafe` block is in
   the SDK's binding layer with a `SAFETY:` comment; malformed config or
   data does not panic or trap where the ABI says the widget handles it;
   any `allow` of a pedantic lint sits on the smallest item with its
   reason; `deny.toml` and the size and memory caps are not loosened.
6. Dependencies: nothing the spec does not name is added, and each widget
   declares an OSI-approved licence (product spec 9.1).
7. Tests: each acceptance criterion has a test, and the golden tests fail
   rather than skip when the modules are not built.
8. The PR edits nothing outside the plan's file scope (lockfiles and
   `schemas/` excepted) and changes nothing under the spec's `design/`.

Judge only against these criteria and the spec's acceptance criteria. Every
finding cites the criterion, the widget or scene, and the file and line.
