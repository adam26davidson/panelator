# Simulator page and Home: flow and interaction notes (spec 115)

The two screens of spec 115 section 7, as Storybook stories in this directory, each rendered at
mobile (390 × 844), tablet (820 × 1180) and desktop (1440 × 900) by spec 029's renderer. The token
set is spec 112's with four additions; `tokens.html` lists every token used.

`@panelator/web` is on `main`, so the stories import the app's own `Frame`, `PageHeading`,
`ReadingColumn`, `Button` and `ButtonLink` from `web/src/shared/ui` and style the new pieces with
the app's Tailwind utilities (`design.css` loads `web/src/app/styles.css`). `@panelator/simulator`
is not on `main`, so the panel in the renders is a golden frame of scene `spike`
(`sdk/conformance/golden/spike/tick-120.png` and `tick-248.png`), enlarged without smoothing; the
app draws the live canvas in its place. The new pieces are in `sim-kit.tsx` and
`simulator.stories.tsx`; "Component mapping" says where each goes in the app.

## Screens and their stories

| Screen | State | Story | Renders | Address | Document title |
|---|---|---|---|---|---|
| Simulator | `running` | `simulator--default` | `simulator.png`, `simulator.mobile.png`, `simulator.tablet.png` | `/simulator` | `Simulator · panelator` |
| Simulator | `loading` | `simulator--loading` | `simulator--loading.png`, `.mobile.png`, `.tablet.png` | `/simulator` | the same |
| Simulator | `paused` | `simulator--paused` | `simulator--paused.png`, `.mobile.png`, `.tablet.png` | `/simulator` | the same |
| Simulator | `failed` | `simulator--failed` | `simulator--failed.png`, `.mobile.png`, `.tablet.png` | `/simulator` | the same |
| Home | none | `home--default` | `home.png`, `home.mobile.png`, `home.tablet.png` | `/` | `panelator` |

## Simulator: layout

The page is inside the frame. Its main region is **full width**, not the reading column: a column
of at most 1376px (`--size-wide`) plus the frame's side padding (16, 24, 32px), centred, with 24px
above it on mobile and 32px from 720px, 32px below, and 24px between its blocks. From top to bottom:

1. **The heading** (`PageHeading`): eyebrow `Runtime spike`, the `h1` `Simulator`, and the lead.
2. **The panel**, in its well, and directly under it (12px) **the run bar**.
3. **The readouts**: the group `Panel` and the group `Placements`.

| | Mobile (under 720px) | Tablet (720 to 1199px) | Desktop (1200px and up) |
|---|---|---|---|
| The well | edge to edge of the viewport (no side padding, no side lines, no corners), 12px above and below the panel | the column's width, 16px padding, 1px outline, 12px corners | the column less the side column, same look |
| Run bar | the column's width | the column's width | the well's width |
| Readouts | under the run bar (32px), `Panel` then `Placements`, stacked 32px apart | under the run bar, `Panel` (280px, `--size-side`) beside `Placements` (the rest), 32px apart | a 280px column to the right of the panel, 32px from it, top-aligned with the well; `Panel` above `Placements`, 32px apart |

### How wide the panel is drawn

The panel is raw pixels: one square per LED, edge to edge, no gaps, no glow, no rounded corners.
The canvas's backing size is the panel's; CSS enlarges it by a whole number of CSS pixels per LED
with `image-rendering: pixelated`. The width the design gives the panel is **the well's content
width less 2px** (the two edge lines), and the scale is the largest whole number at which the panel
fits that width, at least 1. It is measured, not looked up, and is measured again when the well
changes size. The panel is centred in the well.

| Viewport | Well's content width | Room for the panel | A 128 × 64 panel | Drawn at |
|---|---|---|---|---|
| mobile 390 | 390px | 388px | 3 px per LED | 384 × 192 |
| tablet 820 | 738px | 736px | 5 px per LED | 640 × 320 |
| desktop 1440 | 1030px | 1028px | 8 px per LED | 1024 × 512 |

From 1440px up the column stops growing, so 1028px is the widest the panel is ever given. The
height is never limited: a tall panel makes the page longer. Given a panel wider than the room at
1 px per LED, the scale is 1, the panel starts at the well's left edge and **the well scrolls
sideways** (`overflow-x: auto`); the page does not. While it overflows, the well is focusable
(`tabindex="0"`, `role="group"`, name `Panel`) so the arrow keys scroll it; otherwise it is not in
the focus order.

### What surrounds the panel

The well is `--color-surface` on the `--color-bg` page. Directly around the LEDs is a 1px line of
`--color-border-strong`, outside the canvas: everything inside the line is panel. The line is
5.8:1 against a black LED and 4.8:1 against the well, so a black LED at the edge is told from the
page. Inside the line an unlit panel is `--color-panel-off` (black).

### The run bar

One row, at least 44px tall, in every state but `failed`:

- left: **the state text**, 16px semibold, with a 12px dot before it (decorative, `aria-hidden`):
  filled `--color-ok` for `Running`, a hollow `--color-border-strong` ring for `Paused`, filled
  `--color-border` while loading. The word, not the dot, carries the state.
- 16px after it: **the tick**: the label `Tick` (14px, `--color-muted`) and the number (16px
  monospace, tabular figures, plain digits with no grouping, never truncated). Not shown while
  loading.
- right end: **the pause control**, a secondary `Button`, 120px wide (`--size-control`) and 44px
  tall at every viewport, so the bar does not move when its label changes. Not shown while loading;
  it appears at the right end when the first frame is drawn, and nothing else moves.

### The readouts

- **Panel**: a group heading (`h2`, the eyebrow look), the size as `128 × 64 LEDs` (20px
  monospace; width, the sign ×, height, as read from the scene), and the caption `Raw pixels: one
  square per LED, no gaps and no glow.` (14px, `--color-muted`).
- **Placements** is **a table**, not a list: three records with the same three attributes, which
  fit in three columns even in the 280px side column. Group heading `Placements`; column headings
  `Module`, `Rate`, `Layer` (14px semibold, `--color-muted`); one row per placement in the scene's
  order, with the module's name as the row heading (14px monospace), its declared rate as `30 Hz`
  and its layer size as `128 × 64` (16px, tabular figures); 1px dividers; and the caption `In
  drawing order, back to front.` The rows are the scene's and the modules': three for scene
  `spike`, however many another scene has. A declared rate of 0 reads `0 Hz`.

## Simulator: states

| State | The panel | Run bar | Readouts |
|---|---|---|---|
| `loading` | its place held at the size it will have (the scene file is part of the build, so the panel's size is known at once), unlit inside its edge line | `Loading the simulator…`; no tick, no control | `Panel` as in `running`; in `Placements` the names and layer sizes (from the scene) are shown and each rate is `–` (to a screen reader, "not loaded yet") until the modules are loaded |
| `running` | the live frame | `Running`, the tick advancing, **Pause** | all values |
| `paused` | the frame of the tick it stopped at | `Paused`, the tick standing still, **Resume** | all values |
| `failed` | not shown | not shown | not shown |

Nothing moves between `loading`, `running` and `paused`: the well, the bar and the readouts keep
their places and sizes.

**Paused at the start.** When the browser reports `prefers-reduced-motion: reduce`, the page goes
from `loading` to `paused` showing the frame of tick 0 and `Tick 0`, and one line is added under
the run bar (8px below it, 14px, `--color-muted`): `Paused because your system asks for reduced
motion. Resume starts the panel.` The line is removed the first time **Resume** is pressed and does
not return. A pause by the control shows no such line.

**`failed`** replaces the panel, the run bar and the readouts with one message region under the
heading, at most 680px wide (`--size-reading`), left-aligned in the column: `--color-surface`, 1px
`--color-border` outline, 12px corners, 16px padding (24px from 720px), its parts 16px apart:

- the eyebrow `Simulator error` in `--color-danger` and the title `The simulator stopped` (20px
  bold);
- the design's sentence: `It could not load or run one of its widgets, so the panel cannot be
  shown. Loading the simulator again may fix that.`;
- the label `What the engine reported` (14px, `--color-muted`) over the engine's message: 14px
  monospace on `--color-bg` in a 1px outlined box with 12px padding, wrapping at any character
  (`overflow-wrap: anywhere`, `white-space: pre-wrap`), so it is never wider than the region and the
  page never scrolls sideways. It is the message of the engine's error as thrown (which placement,
  which rule); for a file that could not be fetched the page writes `<file name>: could not be
  fetched (<status or the network error>)` in the same box. No stack: that goes to the console.
- **Load the simulator again**, a primary `Button`: the column's full width on mobile, its own
  width from 720px.

The frame is unchanged in `failed`: the name in the band still leads home.

## Home

Spec 112's Home with one change, in the note at the foot of the column. The note is the same
surface box; it now holds two things, 16px apart:

- the paragraph: **Under construction.** `The editor and board control are not in this app yet. The
  simulator page runs the runtime spike's three widgets.`
- **Open the simulator**, a primary `ButtonLink` to `/simulator`: the note's full width on mobile,
  its own width from 720px, 44px tall.

It is Home's one link besides the name in the band. The eyebrow, heading, lead and the list of
three parts are spec 112's, word for word.

## Transitions

| From | Action | To |
|---|---|---|
| Home | **Open the simulator** | Simulator at `/simulator`, by the router, without a page load; it starts in `loading` |
| Simulator, any state | The name in the band | Home at `/`, by the router, without a page load; the run is stopped |
| `/simulator` loaded directly | | Simulator in `loading` |
| `loading` | every file fetched and `pn_init` returned | `running`; or `paused` at tick 0 when reduced motion is asked for |
| `loading` | a file cannot be fetched, or a module fails to load | `failed` |
| `running` | **Pause** | `paused` |
| `paused` | **Resume** | `running`, from the tick it stopped at; time spent paused is not caught up |
| `running` or `paused` | a step ends in an error | `failed` |
| `failed` | **Load the simulator again** | `loading` (every file is fetched again), then `running` (or `paused` under reduced motion) or `failed` |
| Simulator, any state | leaving the page (the name, the browser's back) | the run is stopped; coming back starts from `loading` and tick 0 |

A tab that was hidden and is shown again stays in `running`; the tick shown jumps ahead (AC-10)
and nothing is announced.

## Focus, keyboard and screen readers

- **Focus order** follows the document.
  - Simulator, `running` and `paused`: the name in the band, then the pause control. (Then the
    well, only while it scrolls sideways.)
  - Simulator, `loading`: the name in the band.
  - Simulator, `failed`: the name in the band, then **Load the simulator again**.
  - Home: the name in the band, then **Open the simulator**.
- **After a navigation** focus moves to the new screen's `h1`, as spec 112 set.
- **Pause and Resume** leave focus on the control. Its accessible name is its label, which is the
  action it will take (`Pause`, `Resume`); it carries no `aria-pressed`. Enter and Space act. There
  is no shortcut key.
- **When `failed` appears** while focus is on the pause control (which is removed), focus moves to
  **Load the simulator again**; otherwise focus is left where it is. After **Load the simulator
  again** is pressed (it is removed), focus moves to the `h1`.
- **What a screen reader is told.** The state text is a polite live region (`role="status"`)
  holding only the state's words, so a change announces `Loading the simulator…`, `Running` or
  `Paused`. The tick is outside that region and is not live: it is never announced as it changes,
  and is read like any text when the user moves to it. The failure region is `role="alert"`, so its
  title, sentence and engine message are announced once when it appears. The reduced-motion line
  is ordinary text after the run bar.
- **The canvas** has `role="img"` and the accessible name `LED panel, 128 by 64, running the
  runtime spike's three widgets: a moving image, a clock and scrolling text` (the two numbers are
  the scene's panel). It is not focusable and has no other text alternative; what it shows is
  decoration of the readouts beside it.
- **Visible focus** is spec 112's 2px white ring, offset 2px. Hover is the buttons' own. The page
  uses no transition or animation of its own; the only motion is the panel, which the pause control
  stops (WCAG 2.2.2).

## Copy

| Where | Words |
|---|---|
| Simulator eyebrow, `h1` | `Runtime spike`, `Simulator` |
| Simulator lead | `The runtime spike's three widgets, running in your browser from the same WebAssembly modules the board runs.` |
| State text | `Loading the simulator…`, `Running`, `Paused` |
| Tick label | `Tick` |
| Pause control | `Pause`, `Resume` |
| Reduced-motion line | `Paused because your system asks for reduced motion. Resume starts the panel.` |
| Panel group | `Panel`; `<width> × <height> LEDs`; `Raw pixels: one square per LED, no gaps and no glow.` |
| Placements group | `Placements`; `Module`, `Rate`, `Layer`; `<n> Hz`; `<width> × <height>`; `In drawing order, back to front.` |
| Failed | `Simulator error`; `The simulator stopped`; `It could not load or run one of its widgets, so the panel cannot be shown. Loading the simulator again may fix that.`; `What the engine reported`; **Load the simulator again** |
| Home's note | **Under construction.** `The editor and board control are not in this app yet. The simulator page runs the runtime spike's three widgets.`; **Open the simulator** |

## Component mapping

`shared/ui`:

| Component | In this directory | What it is |
|---|---|---|
| `PanelView` (new) | `PanelView` in `sim-kit.tsx` | the well, the panel's edge line, the whole-number scale rule and the sideways scroll. It takes the panel's width and height and the accessible name, renders the `canvas` at that backing size and hands the canvas to its caller, and holds no geometry of its own. Before a frame is presented the canvas shows `--color-panel-off`, which is the `loading` look. `layout-editor` reuses it. It gets its own story in the app, at two panel sizes. |
| `Frame`, `PageHeading`, `ReadingColumn`, `Button`, `ButtonLink` | imported from `web/src/shared/ui` | unchanged |

`pages/simulator` (the page's own, not shared):

| Piece | In this directory | What it is |
|---|---|---|
| the wide column | `WideColumn` in `sim-kit.tsx` | the full-width main region's layout |
| the run bar | `RunBar` | state text, tick, pause control |
| the readouts | `Readouts`, `GroupHeading` | the two groups and their arrangement at the three viewports |
| the failure region | `Failure` | the `failed` state |
| the view | `SimulatorView` | takes the state, the panel, the placements, the tick and the message as properties (AC-14), so every state renders with no WebAssembly and no canvas context |

`pages/home`: the note with its paragraph and the `ButtonLink`.

`design.css` holds the four new tokens, which the implementation adds to `web/src/app/styles.css`.
Its `.design-root` block is for the design renderer only (it restates seven of the app's colours
over the renderer's base tokens) and is not carried into the app.

## Thresholds this design was held to

- Tap targets: the name in the band, the pause control (120 × 44), **Load the simulator again** and
  **Open the simulator** are at least 44 CSS pixels in both dimensions at every viewport.
- Text: the smallest text is 14px.
- Contrast: every text pair is 8:1 or more, and the panel's edge and button outlines are 4.8:1 or
  more against what they touch; `tokens.html` lists each pair.
- Nothing scrolls the page sideways at any width from 320px up; only the well may scroll, for a
  panel wider than it at 1 px per LED.
