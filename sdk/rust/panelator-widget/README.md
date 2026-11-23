# panelator-widget

The Rust SDK for panelator widgets, on [widget ABI 0.1](../../../docs/widget-abi.md). `no_std`,
no allocator, no dependencies. A widget crate built on it contains no `unsafe` and no `extern`
block: the SDK holds the imports and `widget!` emits the exports and the panic handler.

A complete widget (a crate of type `cdylib`, built for `wasm32-unknown-unknown`):

```rust
#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_code)]

use panelator_widget::{Color, Font, Widget, draw, layer, time};

struct Hello {
    ticks: u64,
}

impl Widget for Hello {
    const UPDATE_HZ: u8 = 1;
    const SIZE: (u16, u16) = (64, 16);

    fn init() -> Self {
        Hello { ticks: 0 }
    }

    fn update(&mut self, tick: u64) {
        self.ticks = tick;
        let (w, _) = layer::size();
        draw::fill(Color::BLACK);
        let now = time::local(time::now(), time::utc_offset());
        let s = [b'0' + now.second / 10, b'0' + now.second % 10];
        let s = core::str::from_utf8(&s).unwrap_or("");
        let x = w - draw::text(Font::Spleen8x16, 0, 0, s, Color::WHITE);
        draw::pixel(x, 0, Color::WHITE);
    }
}

panelator_widget::widget!(Hello);
```

Config is read as bytes and looked up by key: `config::read(&mut buf)` fills `buf`, then
`config::str(&buf[..n], "text", &mut out)`, `config::i64(doc, key)` and `config::bool(doc, key)`.
Images are blitted by name (`image::blit`); the module never holds the bytes.

The pure parts (config readers, `time::local`) have unit tests that run on the build machine's own
target; `sdk/rust/check.sh` runs them with the rest.
