# Conformance suite

The material every host of [widget ABI 0.1](../../docs/widget-abi.md) is tested against: the
device runtime, the browser engine and the Rust test host (`sdk/rust/test-host`, the reference).
Same module, same scene, same frames, in every host (product spec 13).

| Path | What it is |
|---|---|
| `scenes/*.json` | A scene: a panel size, a start time and timezone, assets, placements (module, position, size, z, opacity, config, seed) and the ticks to capture. Format: the document's "The conformance profile". |
| `fonts/` | `spleen-5x8.bdf` (font 1) and `spleen-8x16.bdf` (font 2), unmodified from Spleen release **2.3.0** (<https://github.com/fcambus/spleen>), with its licence, `LICENSE-spleen` (BSD 2-Clause). |
| `assets/spike-image.rgb` | 24,576 bytes: 128 by 64 raw RGB, one frame. Pixel `(x, y)`: `R = x * 255 / 127`, `G = y * 255 / 63`, `B = 255` when `x / 8 + y / 8` is even, else 0. |
| `config/vectors.json` | Configs as the text a scene file can hold, with the canonical bytes a host serves for each (`cases`), and configs a host refuses (`rejected`). Format: the document's "Config". |
| `golden/<scene>/tick-<n>.png` | The composed frame of scene `<scene>` at tick `n`: an 8-bit RGB PNG. |
| `golden/<scene>/frames.json` | The scene's name, the panel size and, per captured tick, the SHA-256 in hex of the frame's raw bytes (RGB, rows top to bottom). |

The scenes are `spike-clock`, `spike-scroll` and `spike-image` (one widget each) and `spike` (the
three together: overlap, z-order, a transparent layer over an image, layer opacity below 255).
The modules they name are the three spike widgets in `widgets/`, built by
`sdk/rust/build-widgets.sh` into `target/widgets/`. Modules are not committed: any build of the
same sources that conforms must produce the same frames.

## Using it from another host

1. Read a scene. Load each placement's module by name (`spike-clock` is `spike-clock.wasm`),
   give it a layer of the placement's size and the config in the document's canonical form
   ("Config"; check your form against `config/vectors.json`), and call
   `pn_init` and then `pn_update` as the document's stepping rules say, with the clock and the
   random sequence of the conformance profile.
2. Compose the frame at each captured tick with the document's integer formula.
3. Compare with `golden/<scene>/tick-<n>.png`, or, if the host cannot read PNG (the board), print
   the SHA-256 of the raw RGB bytes and compare it with `frames.json`.

## The Rust test host

```
panelator-test-host run   <scene> --modules <dir> --out <dir>
panelator-test-host check <scene> --modules <dir> --golden <dir> [--actual <dir>]
panelator-test-host inspect <module>
```

`check` exits 0 when every captured frame equals its golden frame, else 1 after printing the first
differing tick and pixel with both colours (`--actual` keeps the frames it produced).
`cargo nextest run` runs one golden test per scene, the consistency tests of this directory and
the three-way test that the document's import table, the host and the SDK agree.

## Regenerating frames

Only when a spec changes what a frame shows, never to make a failing test pass:

```
sdk/rust/build-widgets.sh
PANELATOR_BLESS=1 cargo nextest run -p panelator-test-host golden_
```

writes `golden/<scene>/` for the four scenes and nothing else. `assets/spike-image.rgb` is
committed; were it ever missing, it is written first by

```
PANELATOR_BLESS=1 cargo nextest run -p panelator-test-host the_spike_image_asset_is_its_formula
```

(the `golden_` filter does not select that test, and the scenes cannot load without the asset).
Then open the PNGs and say in the pull request which frames changed and why. CI never sets
`PANELATOR_BLESS`.
