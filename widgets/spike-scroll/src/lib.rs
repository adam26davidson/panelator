//! The spike scroll: 60 Hz, 128 by 16. Text that moves one pixel a tick by its own code, the
//! 60 Hz load of the runtime spike (positions and colours: spec 107, `design/flow.md`).

#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_code)]

use panelator_widget::{Color, Font, Widget, config, draw, layer, random, text};

const BACKGROUND: Color = Color(0x0B1F_3AFF);
const COLORS: [Color; 6] = [Color(0xFFB0_00FF), Color(0xFFFF_FFFF), Color(0x5CFF_8AFF), Color(0x4FD8_FFFF), Color(0xFF7A_B6FF), Color(0xB9A1_FFFF)];
const DEFAULT_TEXT: &str = "panelator";

/// The widget.
pub struct Scroll {
    text: [u8; 64],
    len: usize,
    width: i32,
    color: usize,
}

impl Scroll {
    fn text(&self) -> &str {
        core::str::from_utf8(&self.text[..self.len]).unwrap_or(DEFAULT_TEXT)
    }

    fn pick() -> usize {
        usize::try_from(random::u32() % 6).unwrap_or(0)
    }
}

impl Widget for Scroll {
    const UPDATE_HZ: u8 = 60;
    const SIZE: (u16, u16) = (128, 16);

    fn init() -> Self {
        let mut doc = [0u8; 256];
        let n = config::read(&mut doc[..config::len().min(256)]);
        let mut me = Scroll { text: [0; 64], len: 0, width: 0, color: 0 };
        let mut out = [0u8; 64];
        let s = config::str(&doc[..n], "text", &mut out).unwrap_or(DEFAULT_TEXT);
        me.len = s.len();
        me.text[..me.len].copy_from_slice(s.as_bytes());
        me.width = text::width(Font::Spleen8x16, me.text());
        me.color = Scroll::pick();
        me
    }

    fn update(&mut self, tick: u64) {
        let (w, h) = layer::size();
        let period = u64::try_from(w + self.width).unwrap_or(1).max(1);
        if tick > 0 && tick % period == 0 {
            self.color = Scroll::pick();
        }
        let x = w - i32::try_from(tick % period).unwrap_or(0);
        let y = (h - Font::Spleen8x16.height()) / 2;
        draw::fill(BACKGROUND);
        draw::text(Font::Spleen8x16, x, y, self.text(), COLORS[self.color % 6]);
    }
}

panelator_widget::widget!(Scroll);
