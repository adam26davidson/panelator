//! What `docs/widget-abi.md` fixes, as data: the version, the exports, the imports.

/// The host's ABI version, major.
pub const MAJOR: u32 = 0;
/// The host's ABI version, minor.
pub const MINOR: u32 = 1;
/// The largest linear memory of a module, in 64 KiB pages.
pub const MAX_PAGES: u64 = 4;

/// A value type of the ABI's function signatures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    /// 32-bit integer.
    I32,
    /// 64-bit integer.
    I64,
}

impl Ty {
    /// The name the document uses.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Ty::I32 => "i32",
            Ty::I64 => "i64",
        }
    }
}

/// One function of a signature table.
#[derive(Debug)]
pub struct Func {
    /// The function's name.
    pub name: &'static str,
    /// Parameter types.
    pub params: &'static [Ty],
    /// The result type, if any.
    pub result: Option<Ty>,
}

use Ty::{I32, I64};

const fn f(name: &'static str, params: &'static [Ty], result: Option<Ty>) -> Func {
    Func { name, params, result }
}

/// The exports besides `memory`.
pub const EXPORTS: &[Func] = &[
    f("pn_abi_version", &[], Some(I32)),
    f("pn_update_hz", &[], Some(I32)),
    f("pn_width", &[], Some(I32)),
    f("pn_height", &[], Some(I32)),
    f("pn_init", &[], None),
    f("pn_update", &[I64], None),
];

/// The imports, all from the module `panelator`.
pub const IMPORTS: &[Func] = &[
    f("layer_width", &[], Some(I32)),
    f("layer_height", &[], Some(I32)),
    f("draw_fill", &[I32], None),
    f("draw_pixel", &[I32, I32, I32], None),
    f("draw_line", &[I32, I32, I32, I32, I32], None),
    f("draw_rect", &[I32, I32, I32, I32, I32, I32], None),
    f("draw_circle", &[I32, I32, I32, I32, I32], None),
    f("draw_text", &[I32, I32, I32, I32, I32, I32], Some(I32)),
    f("text_width", &[I32, I32, I32], Some(I32)),
    f("font_height", &[I32], Some(I32)),
    f("draw_image", &[I32, I32, I32, I32, I32], Some(I32)),
    f("config_len", &[], Some(I32)),
    f("config_read", &[I32, I32], Some(I32)),
    f("time_unix_ms", &[], Some(I64)),
    f("time_utc_offset_s", &[], Some(I32)),
    f("random_u32", &[], Some(I32)),
];

/// The signature of `f` as one string, `(i32,i32)->i32`, the form the tests compare.
#[must_use]
pub fn signature(f: &Func) -> String {
    let params: Vec<_> = f.params.iter().map(|t| t.name()).collect();
    format!("({})->{}", params.join(","), f.result.map_or("()", Ty::name))
}

/// Whether a placement's update is due at `tick` (AC-5 of spec 107, "When a widget is called").
#[must_use]
pub fn update_due(hz: u32, tick: u64) -> bool {
    if tick == 0 {
        return true;
    }
    hz > 0 && (u128::from(tick) * u128::from(hz)) / 60 != (u128::from(tick - 1) * u128::from(hz)) / 60
}

/// The xorshift32 step of the conformance profile; returns the new state, which is the value.
#[must_use]
pub fn xorshift32(mut x: u32) -> u32 {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x
}
