//! Stand-ins for the imports on the build machine's own target, so the SDK's pure parts and the
//! crates built on it compile and their unit tests link. Calling one panics: a widget runs in a host.

macro_rules! stubs {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {$(
        pub unsafe fn $name($($arg: $ty),*) $(-> $ret)? {
            $(let _ = $arg;)*
            unreachable!(concat!("the import ", stringify!($name), " exists only inside a host"))
        }
    )*};
}

stubs! {
    fn layer_width() -> i32;
    fn layer_height() -> i32;
    fn draw_fill(color: i32);
    fn draw_pixel(x: i32, y: i32, color: i32);
    fn draw_line(x0: i32, y0: i32, x1: i32, y1: i32, color: i32);
    fn draw_rect(x: i32, y: i32, w: i32, h: i32, color: i32, filled: i32);
    fn draw_circle(cx: i32, cy: i32, r: i32, color: i32, filled: i32);
    fn draw_text(font: i32, x: i32, y: i32, ptr: i32, len: i32, color: i32) -> i32;
    fn text_width(font: i32, ptr: i32, len: i32) -> i32;
    fn font_height(font: i32) -> i32;
    fn draw_image(name_ptr: i32, name_len: i32, frame: i32, x: i32, y: i32) -> i32;
    fn config_len() -> i32;
    fn config_read(ptr: i32, cap: i32) -> i32;
    fn time_unix_ms() -> i64;
    fn time_utc_offset_s() -> i32;
    fn random_u32() -> i32;
}
