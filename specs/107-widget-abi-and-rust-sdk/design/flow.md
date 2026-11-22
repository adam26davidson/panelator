# Spike widgets design: positions, colours and notes (spec 107)

The four screens of spec 107 section 6, as Storybook stories in this directory, each rendered at
mobile (390 × 844), tablet (820 × 1180) and desktop (1440 × 900) by spec 029's renderer. Each
screen shows a frame as raw pixels, one flat square per LED, enlarged, on black, with no emulated
LED look, and under it the table of what is drawn where. Tokens are in `tokens.html`.

This file is the binding part of the design: **the implementation takes every position and colour
below.** Positions are layer pixels (origin top-left, x right, y down); colours are `0xRRGGBBAA`.

## Screens and their stories

| Screen | Stories | What each frame is |
|---|---|---|
| `spike-clock` | Default (both states), EvenSecond, OddSecond | `even-second`: tick 0 of scene `spike-clock`, `23:59:58`, `2026-12-31`, circle filled. `odd-second`: tick 60, `23:59:59`, circle outlined |
| `spike-scroll` | Default (both states), Entering, Leaving | The declared 128 by 16 layer, text `panelator 60 Hz`, seed 2. `entering`: tick 52, text at x = 76. `leaving`: tick 676, text at x = -52 |
| `spike-image` | Default (both states), Offset0, Offset40 | `offset-0`: tick 0, the asset as it is. `offset-40`: tick 80, the wrap at column 88 |
| `spike-scene` | Default | The 128 by 64 panel of scene `spike` at tick 60 |

## Flow and interaction

There is none. The spec names no transition between the screens: they are four independent frames
of three widgets that take no input (events are not in ABI 0.1). Nothing on a screen is a control,
so there are no tap targets. Each widget's only change over time is its update rule, given below.

## spike-clock (64 by 32, 1 Hz)

Every update draws these, in this order. `second` is the local second, 0 to 59.

| # | Element | Call | Position | Colour |
|---|---|---|---|---|
| 1 | Clear | `draw_fill` | the whole layer | `0x00000000` transparent |
| 2 | Time halo | `draw_text` × 4, font 2 | the time's string with its first cell at (-1, 0), (1, 0), (0, -1), (0, 1) | `0x000000FF` black |
| 3 | Time `HH:MM:SS` | `draw_text`, font 2 | first cell at (0, 0); 8 cells of 8 × 16 = 64 × 16 | `0xFFFFFFFF` white |
| 4 | Plate | `draw_rect`, filled | x 0, y 13, 64 × 11 (rows 13 to 23) | `0x000000FF` black |
| 5 | Separator | `draw_line` | (0, 14) to (63, 14) | `0x4FD8FFFF` cyan |
| 6 | Seconds bar, outline | `draw_rect`, not filled | x 1, y 17, 62 × 5 | `0x4FD8FFFF` cyan |
| 7 | Seconds bar, fill | `draw_rect`, filled | x 2, y 18, `second` × 3 | `0xFFB000FF` amber |
| 8 | Quarter marks | `draw_pixel` × 4 | (2, 22), (17, 22), (32, 22), (47, 22) | `0xFFFFFFFF` white |
| 9 | Date halo | `draw_text` × 4, font 1 | the date's string with its first cell at (0, 24), (2, 24), (1, 23), (1, 25) | `0x000000FF` black |
| 10 | Date `YYYY-MM-DD` | `draw_text`, font 1 | first cell at (1, 24); 10 cells of 5 × 8 = 50 × 8 | `0xFFFFFFFF` white |
| 11 | Disc | `draw_circle`, filled | centre (59, 27), radius 4 (x 55 to 63, y 23 to 31) | `0x000000FF` black |
| 12 | Seconds circle | `draw_circle`, filled when `second` is even, else outlined | centre (59, 27), radius 3 (x 56 to 62, y 24 to 30) | `0x5CFF8AFF` green |

Decisions behind the numbers:

- **Rows.** Font 2's digits ink rows 2 to 11 of their cell and the colon rows 5 to 11, so rows 12
  to 15 of the time's cells are empty. The separator sits in them, at row 14, which leaves two
  blank rows between the time's ink, the separator, the bar and the date's ink (rows 25 to 30) and
  one blank row at the bottom. The separator is drawn after the time and overlaps no glyph pixel.
- **The bar counts seconds one column each.** The outline's inside is 60 by 3 (x 2 to 61, y 18 to
  20) and the fill is `second` columns wide: empty at second 0 (a `draw_rect` of width 0, which
  draws nothing), 59 wide at second 59. A quarter mark for second `m` is at x = 2 + `m`, on the row
  under the outline, so it reads as a tick hanging from the bar; the fill reaches a mark's column
  one second after `m`.
- **Fixed positions.** The clock does not read its layer's size: on a layer of another size the
  same pixels are drawn and the host clips them.
- **Colour roles.** White is text and marks; cyan is the frame (separator, outline); amber and
  green are the two things that change every second; black is the ground.
- **The black ground (elements 2, 4, 9, 11).** The layer is cleared to transparent, so on a black
  panel these four draw nothing a viewer can see: the `spike-clock` screen looks the same with or
  without them. They are there for a clock placed over something else (scene `spike`). A draw call
  sets pixels and nothing blends inside a layer, so a colour drawn straight onto a transparent
  layer has whatever is under the layer as its background. The halo is the text drawn four times
  in opaque black, moved one pixel left, right, up and down, before it is drawn in white: every
  glyph pixel on a glyph's edge then has a black pixel across that edge. The plate is the ground of
  the separator, the bar and the marks; the disc is the ground of the circle and keeps the outlined
  circle's inside black. None of them touches another element's pixels: the time's halo ends at row
  12, the plate is rows 13 to 23, the date's halo is rows 24 to 31 and columns 0 to 50, the disc
  starts at column 55 (its top pixels, on row 23, lie on the plate). Left of column 0 the time's
  halo is clipped by the layer.
- **What stays transparent.** Everything not listed: the pixels of the time's and the date's
  cells that no glyph and no halo covers (row 0, the counters of the digits, the gaps around the
  colons and the hyphens), the columns between the date and the disc, the corners around the
  disc. At 23:59:59
  that is 472 of the layer's 2048 pixels; 855 are black.

## spike-scroll (128 by 16, 60 Hz)

`W` and `H` are the layer's width and height (`layer_width`, `layer_height`), `tw` is
`text_width(2, text)`, `fh` is `font_height(2)`.

| # | Element | Call | Position | Colour |
|---|---|---|---|---|
| 1 | Background | `draw_fill` | the whole layer | `0x0B1F3AFF` navy |
| 2 | Text (config `text`, default `panelator`) | `draw_text`, font 2 | x = `W - (tick % (W + tw))`, y = `(H - fh) / 2` | the current text colour |

The six text colours, in the order of the index:

| Index | Name | Colour | Contrast on the background | On black |
|---|---|---|---|---|
| 0 | amber | `0xFFB000FF` | 9.0 | 11.5 |
| 1 | white | `0xFFFFFFFF` | 16.5 | 21.0 |
| 2 | green | `0x5CFF8AFF` | 12.7 | 16.1 |
| 3 | cyan | `0x4FD8FFFF` | 9.9 | 12.6 |
| 4 | pink | `0xFF7AB6FF` | 6.9 | 8.7 |
| 5 | violet | `0xB9A1FFFF` | 7.6 | 9.6 |

- **The index** is `random_u32() % 6` with the value taken as unsigned 32 bits (the import returns
  it in an `i32`; a signed remainder would give a negative index). One value is drawn at `pn_init`
  and one more at each tick where `tick > 0` and `tick % (W + tw) == 0`, which is the tick where
  the text is wholly outside again at x = `W`. With seed 2 the first three values are 540738,
  134253570 and 697882754, so the passes are amber, amber, green.
- **Vertical position.** At the declared height 16 the cells fill the layer and y is 0. On a taller
  layer the text is centred; on a shorter one y is negative and the text is clipped top and
  bottom alike.
- **The background is opaque and not black**, so the layer's extent shows on a black panel and it
  hides what is under it in scene `spike`.
- **The states.** `entering` is the first pass (amber); `leaving` is the third pass, the first one
  in a new colour (green), so the two frames show a colour change as well as both edges. Both clip
  a glyph mid-cell.

## spike-image (128 by 64, 30 Hz)

`W` is the layer's width, `o = (tick / 2) % W`.

| # | Element | Call | Position | Colour |
|---|---|---|---|---|
| 1 | First blit | `draw_image(asset, frame 0)` | x = `-o`, y = 0 | the asset's pixels, alpha 255 |
| 2 | Second blit | `draw_image(asset, frame 0)` | x = `W - o`, y = 0 | the asset's pixels, alpha 255 |
| - | Failure | `draw_fill`, when a blit returns an error | the whole layer | `0xFF00FFFF` magenta |

The asset is the config's `asset` (default `spike-image`). The widget draws nothing over or beside
the image, so at `o = 0` the frame equals the asset (AC-17). When the first blit fails the widget
fills and does not call the second.

## spike-scene (the 128 by 64 panel of scene `spike`)

| Placement | x, y | Size | z | Opacity | What shows |
|---|---|---|---|---|---|
| `spike-image` | 0, 0 | 128 × 64 | 0 | 255 | the whole panel, then covered below row 48 |
| `spike-clock` | 0, 0 | 64 × 32 | 1 | 200 | the top-left quarter; the image shows through every pixel the clock did not draw |
| `spike-scroll` | 0, 48 | 128 × 16 | 2 | 255 | the bottom 16 rows, opaque |

The frame is tick 60: `23:59:59`, image offset 30, scroll text at x = 68 in amber.

**Readability over the image.** The clock's layer is composed at opacity 200 over an image that
moves under it, running from black to (255, 125, 255) under the clock as it scrolls. No colour
keeps a fixed contrast against that by itself: drawn straight onto the image, white text falls to
1.9 to 1 where a bright square passes under a glyph, and the cyan, amber and green shapes to 1.3
to 1. That is why every clock element sits on or beside opaque black (the halos, the plate and the
disc of the clock's table). Black at opacity 200 leaves at most 55 of 255 of the image in each
channel, so the ground is near black whatever the image holds. Measured on the composed panel over
all 128 image offsets, each coloured pixel against the black pixels next to it:

| Element | Lowest contrast against its black ground | Average |
|---|---|---|
| Time (white) | 10.5 to 1 | 12.8 |
| Date (white) | 11.0 to 1 | 13.2 |
| Quarter marks (white) | 11.9 to 1 | 13.2 |
| Separator and bar outline (cyan) | 7.4 to 1 | 8.2 |
| Bar fill (amber) | 7.1 to 1 | 7.7 |
| Seconds circle (green) | 8.9 to 1 | 10.3 |

The image still shows through every pixel the clock leaves transparent (inside and between the
glyphs' halos, right of the date, around the disc), which is the load the scene is for: a
transparent layer over an image at a layer opacity below 255. On black, the clock's own scene,
every clock colour is at least 11.5 to 1. The scroll's six colours are on its own opaque navy
background in every scene (table above).

## How the stories make their pixels

`spike-pixels.ts` holds the geometry and colour constants above and a small model of the ABI's
draw calls and of AC-11's composition; the stories run the three widgets' update rules through it.
So a frame here should equal the golden frame of the same scene and tick (`spike-clock` ticks 0
and 60, `spike-image` tick 0, `spike` tick 60), which is the comparison spec section 5 gives the
reviewer.

- **Glyphs.** The stories draw the real glyphs: a subset of Spleen 5x8 and 8x16 from upstream
  release 2.3.0 (BSD 2-Clause; the notice is in `spike-pixels.ts`). The conformance fonts of AC-12
  should be that release, so the golden frames match these renders glyph for glyph.
- **Circle.** The model uses the usual integer midpoint circle (start at (r, 0) with d = 1 - r).
  For radius 3 the outline is 16 pixels: (±3, 0), (±3, ±1), (±2, ±2), (±1, ±3), (0, ±3) from the
  centre. For radius 4, filled (the disc), the rows from the centre's are 9, 9, 7, 7 and 3 pixels
  wide, above and below alike, so the disc holds every pixel next to the outline. If the
  pseudo-code in `docs/widget-abi.md` gives other pixels, the document wins and the centres and
  radii stay as designed.
- **Page.** A frame is 320 CSS pixels wide on mobile, 768 on tablet and 1024 on desktop, always a
  whole number of device pixels per LED. The grey one-pixel outline around a frame marks its edge
  and is not part of it.
