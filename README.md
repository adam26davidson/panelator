# panelator

An open-source, fully configurable LED dashboard. A HUB75 LED panel driven by an
ESP32-S3 renders everything on the board. A companion web app lets you build
screens from widgets with drag and drop, preview them in a realistic simulator,
and control the board live. Write your own widgets as WebAssembly modules and
share them on the marketplace.

Status: requirements settled, nothing built yet. First milestone is the widget
runtime spike (see the product spec, section 12).

## Documents

- [docs/product-spec.md](docs/product-spec.md): what panelator is and how it is built.
- [docs/process-spec.md](docs/process-spec.md): how this repo is developed, mostly by AI agents, and where the human is.
- [docs/design-tree.md](docs/design-tree.md): every requirements question, the alternatives, and why each decision won. Read before re-opening a decision.
- `docs/decisions/`: architecture decision records.
- `specs/`: one spec per feature.
- `dev-logs/`: dated measured findings.

## Layout

```
firmware/            ESP-IDF firmware for the ESP32-S3
backend/             Rust backend (axum, Postgres), self-hostable
web/                 React web app (Feature-Sliced Design)
sdk/rust/            Widget SDK (primary)
sdk/assemblyscript/  Widget SDK (secondary)
widgets/             Built-in widgets, written against the SDK
schemas/             JSON Schema generated from Rust types
hardware/            Carrier PCB (CERN-OHL-S)
```

## Licence

Software: Apache-2.0 (see [LICENSE](LICENSE)). Hardware under `hardware/`:
CERN-OHL-S, added when the hardware files move in.

## Predecessor

Panelator grows out of
[char-matrix-dashboard](https://github.com/adam26davidson/char-matrix-dashboard),
a desktop dashboard that streamed 1-bit frames to the same panel over UDP.
