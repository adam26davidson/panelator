//! The spike image: 30 Hz, 128 by 64. A 24 KB image blitted twice, side by side, shifted one
//! column every second update, so it wraps (spec 107, `design/flow.md`).

#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_code)]

use panelator_widget::{Color, Widget, config, draw, image, layer};

const DEFAULT_ASSET: &str = "spike-image";
const MAGENTA: Color = Color(0xFF00_FFFF);

/// The widget.
pub struct Spike {
    name: [u8; 64],
    len: usize,
}

impl Spike {
    fn name(&self) -> &str {
        core::str::from_utf8(&self.name[..self.len]).unwrap_or(DEFAULT_ASSET)
    }
}

impl Widget for Spike {
    const UPDATE_HZ: u8 = 30;
    const SIZE: (u16, u16) = (128, 64);

    fn init() -> Self {
        let mut doc = [0u8; 256];
        let n = config::read(&mut doc[..config::len().min(256)]);
        let mut out = [0u8; 64];
        let s = config::str(&doc[..n], "asset", &mut out).unwrap_or(DEFAULT_ASSET);
        let mut me = Spike {
            name: [0; 64],
            len: s.len(),
        };
        me.name[..me.len].copy_from_slice(s.as_bytes());
        me
    }

    fn update(&mut self, tick: u64) {
        let (w, _) = layer::size();
        let o = i32::try_from((tick / 2) % u64::try_from(w).unwrap_or(1).max(1)).unwrap_or(0);
        if image::blit(self.name(), 0, -o, 0).is_err()
            || image::blit(self.name(), 0, w - o, 0).is_err()
        {
            draw::fill(MAGENTA);
        }
    }
}

panelator_widget::widget!(Spike);
