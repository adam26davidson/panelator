//! The imports of `docs/widget-abi.md`, as the WebAssembly module sees them.
//! One function a line: a test in the host compares this block with the document.

#[link(wasm_import_module = "panelator")]
unsafe extern "C" {
    pub fn layer_width() -> i32;
    pub fn layer_height() -> i32;
    pub fn draw_fill(color: i32);
    pub fn draw_pixel(x: i32, y: i32, color: i32);
    pub fn draw_line(x0: i32, y0: i32, x1: i32, y1: i32, color: i32);
    pub fn draw_rect(x: i32, y: i32, w: i32, h: i32, color: i32, filled: i32);
    pub fn draw_circle(cx: i32, cy: i32, r: i32, color: i32, filled: i32);
    pub fn draw_text(font: i32, x: i32, y: i32, ptr: i32, len: i32, color: i32) -> i32;
    pub fn text_width(font: i32, ptr: i32, len: i32) -> i32;
    pub fn font_height(font: i32) -> i32;
    pub fn draw_image(name_ptr: i32, name_len: i32, frame: i32, x: i32, y: i32) -> i32;
    pub fn config_len() -> i32;
    pub fn config_read(ptr: i32, cap: i32) -> i32;
    pub fn time_unix_ms() -> i64;
    pub fn time_utc_offset_s() -> i32;
    pub fn random_u32() -> i32;
}
