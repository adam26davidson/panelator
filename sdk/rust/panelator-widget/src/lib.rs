//! The Rust SDK for panelator widgets, on widget ABI 0.1 (`docs/widget-abi.md`).
//!
//! A widget implements [`Widget`] and names its type to [`widget!`], which emits the exports the
//! ABI requires and the panic handler. This crate is the only one in the repository that contains
//! `unsafe`: the calls to the host imports, and the one static a widget keeps its state in.
//!
//! Everything here is `no_std` and allocation-free. On the build machine's own target the imports
//! are stand-ins that panic, so the pure parts (config readers, date arithmetic) can be unit tested.

#![cfg_attr(not(test), no_std)]

pub mod config;
pub mod time;

#[cfg(target_arch = "wasm32")]
mod sys;
#[cfg(not(target_arch = "wasm32"))]
mod sys_host;
#[cfg(not(target_arch = "wasm32"))]
use sys_host as sys;

use core::cell::UnsafeCell;

/// The ABI version this SDK is built for, as `pn_abi_version` returns it: `(major << 16) | minor`.
pub const ABI_VERSION: i32 = 1;

/// A pointer as the `i32` the imports take (WebAssembly pointers are 32 bits).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    reason = "a wasm32 pointer is 32 bits"
)]
pub(crate) fn ptr_arg(p: *const u8) -> i32 {
    p as usize as i32
}

fn len_arg(len: usize) -> i32 {
    i32::try_from(len).unwrap_or(i32::MAX)
}

/// A colour, `0xRRGGBBAA`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color(pub u32);

impl Color {
    /// Fully transparent (every channel 0).
    pub const TRANSPARENT: Color = Color(0);
    /// Opaque black.
    pub const BLACK: Color = Color(0x0000_00FF);
    /// Opaque white.
    pub const WHITE: Color = Color(0xFFFF_FFFF);

    /// A colour from its four channels.
    #[must_use]
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color(u32::from_be_bytes([r, g, b, a]))
    }

    /// An opaque colour from its three channels.
    #[must_use]
    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color::rgba(r, g, b, 255)
    }

    #[allow(
        clippy::cast_possible_wrap,
        reason = "the ABI passes the 32 bits of a colour in an i32"
    )]
    const fn arg(self) -> i32 {
        self.0 as i32
    }
}

/// One of the host's fonts (ABI 0.1 has two, both Spleen).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Font {
    /// Spleen 5x8, font id 1.
    Spleen5x8 = 1,
    /// Spleen 8x16, font id 2.
    Spleen8x16 = 2,
}

impl Font {
    /// The font's cell height in pixels.
    #[must_use]
    pub fn height(self) -> i32 {
        // SAFETY: `font_height` takes a number and returns a number.
        unsafe { sys::font_height(self as i32) }
    }
}

/// The widget's layer.
pub mod layer {
    /// The layer's width and height in pixels.
    #[must_use]
    pub fn size() -> (i32, i32) {
        // SAFETY: both imports take no arguments and only return a number.
        unsafe { (crate::sys::layer_width(), crate::sys::layer_height()) }
    }
}

/// Drawing on the layer. A call sets the pixels it covers (nothing is blended) and clips to the
/// layer; any coordinate or size is legal.
pub mod draw {
    use crate::{Color, Font, len_arg, ptr_arg, sys};

    /// Sets every pixel.
    pub fn fill(color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_fill(color.arg()) }
    }

    /// Sets one pixel.
    pub fn pixel(x: i32, y: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_pixel(x, y, color.arg()) }
    }

    /// Draws a line from `(x0, y0)` to `(x1, y1)`, both ends included.
    pub fn line(x0: i32, y0: i32, x1: i32, y1: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_line(x0, y0, x1, y1, color.arg()) }
    }

    /// Draws the one-pixel border of the `w` by `h` rectangle at `(x, y)`.
    pub fn rect(x: i32, y: i32, w: i32, h: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_rect(x, y, w, h, color.arg(), 0) }
    }

    /// Fills the `w` by `h` rectangle at `(x, y)`.
    pub fn fill_rect(x: i32, y: i32, w: i32, h: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_rect(x, y, w, h, color.arg(), 1) }
    }

    /// Draws the outline of the circle of radius `r` around `(cx, cy)`.
    pub fn circle(cx: i32, cy: i32, r: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_circle(cx, cy, r, color.arg(), 0) }
    }

    /// Fills the circle of radius `r` around `(cx, cy)`.
    pub fn fill_circle(cx: i32, cy: i32, r: i32, color: Color) {
        // SAFETY: the import takes numbers only.
        unsafe { sys::draw_circle(cx, cy, r, color.arg(), 1) }
    }

    /// Draws `s` in `font` with its first cell's top-left at `(x, y)`, setting only the glyphs'
    /// pixels. Returns the advance in pixels.
    #[allow(clippy::must_use_candidate, reason = "the advance is often not needed")]
    pub fn text(font: Font, x: i32, y: i32, s: &str, color: Color) -> i32 {
        // SAFETY: the host reads `s.len()` bytes at `s`, which this module owns.
        unsafe {
            sys::draw_text(
                font as i32,
                x,
                y,
                ptr_arg(s.as_ptr()),
                len_arg(s.len()),
                color.arg(),
            )
        }
    }
}

/// Measuring text.
pub mod text {
    use crate::{Font, len_arg, ptr_arg, sys};

    /// The advance of `s` in `font` in pixels, as `draw::text` would return it.
    #[must_use]
    pub fn width(font: Font, s: &str) -> i32 {
        // SAFETY: the host reads `s.len()` bytes at `s`, which this module owns.
        unsafe { sys::text_width(font as i32, ptr_arg(s.as_ptr()), len_arg(s.len())) }
    }
}

/// Blitting an asset the host holds.
pub mod image {
    use crate::{len_arg, ptr_arg, sys};

    /// Why a blit drew nothing.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Error {
        /// The host has no asset of that name.
        NoSuchAsset,
        /// The asset has no such frame.
        NoSuchFrame,
    }

    /// Sets the layer's pixels from frame `frame` of the asset `name`, top-left at `(x, y)`, opaque.
    ///
    /// # Errors
    /// [`Error::NoSuchAsset`] or [`Error::NoSuchFrame`]; nothing is drawn.
    pub fn blit(name: &str, frame: i32, x: i32, y: i32) -> Result<(), Error> {
        // SAFETY: the host reads `name.len()` bytes at `name`, which this module owns.
        let r =
            unsafe { sys::draw_image(ptr_arg(name.as_ptr()), len_arg(name.len()), frame, x, y) };
        match r {
            0 => Ok(()),
            -2 => Err(Error::NoSuchFrame),
            _ => Err(Error::NoSuchAsset),
        }
    }
}

/// Random numbers.
pub mod random {
    /// 32 random bits from the host.
    #[must_use]
    pub fn u32() -> u32 {
        // SAFETY: the import takes no arguments and only returns a number.
        let v = unsafe { crate::sys::random_u32() };
        v.cast_unsigned()
    }
}

/// A widget: its declarations and its two entry points.
pub trait Widget: Sized {
    /// The declared update rate: 0 for on data change only, 1 to 60 updates a second.
    const UPDATE_HZ: u8;
    /// The declared size in LEDs, width and height, each 1 to 4096.
    const SIZE: (u16, u16);
    /// Called once, before any update; it may draw.
    fn init() -> Self;
    /// Called when an update is due, with the current tick (60 a second); it may draw.
    fn update(&mut self, tick: u64);
}

/// The one place a widget keeps its state between calls. Used by [`widget!`].
pub struct Slot<T>(UnsafeCell<Option<T>>);

// SAFETY: a module is single threaded (no threads feature), so there is no concurrent access.
unsafe impl<T> Sync for Slot<T> {}

impl<T> Slot<T> {
    /// An empty slot.
    #[must_use]
    pub const fn new() -> Self {
        Slot(UnsafeCell::new(None))
    }

    /// Stores the value, dropping any earlier one.
    pub fn set(&self, value: T) {
        // SAFETY: single threaded and not re-entered: no reference into the slot is alive here.
        unsafe { *self.0.get() = Some(value) }
    }

    /// Runs `f` on the value; does nothing before `set`.
    pub fn with(&self, f: impl FnOnce(&mut T)) {
        // SAFETY: as in `set`; `f` cannot reach the slot again because it has no access to it.
        if let Some(v) = unsafe { (*self.0.get()).as_mut() } {
            f(v);
        }
    }
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Emits every export of widget ABI 0.1 for a type implementing [`Widget`], and the panic handler
/// (a panic is a trap). Use it once in a widget crate:
///
/// ```ignore
/// panelator_widget::widget!(MyWidget);
/// ```
#[macro_export]
macro_rules! widget {
    ($ty:ty) => {
        static __PANELATOR_SLOT: $crate::Slot<$ty> = $crate::Slot::new();

        #[unsafe(no_mangle)]
        pub extern "C" fn pn_abi_version() -> i32 {
            $crate::ABI_VERSION
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn pn_update_hz() -> i32 {
            i32::from(<$ty as $crate::Widget>::UPDATE_HZ)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn pn_width() -> i32 {
            i32::from(<$ty as $crate::Widget>::SIZE.0)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn pn_height() -> i32 {
            i32::from(<$ty as $crate::Widget>::SIZE.1)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn pn_init() {
            __PANELATOR_SLOT.set(<$ty as $crate::Widget>::init());
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn pn_update(tick: i64) {
            __PANELATOR_SLOT.with(|w| <$ty as $crate::Widget>::update(w, tick.cast_unsigned()));
        }

        #[cfg(all(target_arch = "wasm32", not(test)))]
        #[panic_handler]
        fn __panelator_panic(_: &core::panic::PanicInfo) -> ! {
            core::arch::wasm32::unreachable()
        }
    };
}
