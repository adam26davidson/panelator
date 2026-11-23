//! The host fonts of ABI 0.1: Spleen 5x8 (font 1) and Spleen 8x16 (font 2), read from the BDF
//! files of `sdk/conformance/fonts/` (embedded at build time).

use std::collections::HashMap;

/// One glyph: its advance, its box and its bitmap rows (each row padded to whole bytes).
#[derive(Clone, Debug)]
pub struct Glyph {
    /// `DWIDTH` x.
    pub advance: i32,
    /// `BBX` width.
    pub width: i32,
    /// `BBX` height.
    pub height: i32,
    /// `BBX` x offset.
    pub x_off: i32,
    /// `BBX` y offset (of the box's bottom edge above the baseline).
    pub y_off: i32,
    rows: Vec<Vec<u8>>,
}

impl Glyph {
    /// Whether the bitmap's pixel at column `col` of row `row` is set.
    #[must_use]
    pub fn bit(&self, col: usize, row: usize) -> bool {
        self.rows.get(row).and_then(|r| r.get(col / 8)).is_some_and(|b| b & (0x80 >> (col % 8)) != 0)
    }
}

/// A bitmap font.
#[derive(Clone, Debug)]
pub struct Font {
    /// The cell height (`FONTBOUNDINGBOX` height).
    pub height: i32,
    /// The bounding-box width: the advance of a missing glyph.
    pub box_width: i32,
    /// `FONT_ASCENT`.
    pub ascent: i32,
    glyphs: HashMap<u32, Glyph>,
}

impl Font {
    /// Parses a BDF file.
    ///
    /// # Errors
    /// A message naming what is missing or malformed.
    pub fn parse(bdf: &str) -> Result<Font, String> {
        let (mut height, mut box_width, mut ascent) = (None, None, None);
        let mut glyphs = HashMap::new();
        let mut lines = bdf.lines();
        while let Some(line) = lines.next() {
            let mut it = line.split_whitespace();
            match it.next() {
                Some("FONTBOUNDINGBOX") => {
                    let v = ints(it)?;
                    box_width = v.first().copied();
                    height = v.get(1).copied();
                }
                Some("FONT_ASCENT") => ascent = ints(it)?.first().copied(),
                Some("STARTCHAR") => {
                    let (mut code, mut advance, mut bbx) = (None, 0, vec![]);
                    let mut rows = vec![];
                    let mut in_bitmap = false;
                    for line in lines.by_ref() {
                        let mut it = line.split_whitespace();
                        match it.next() {
                            Some("ENCODING") => code = ints(it)?.first().copied(),
                            Some("DWIDTH") => advance = *ints(it)?.first().ok_or("DWIDTH")?,
                            Some("BBX") => bbx = ints(it)?,
                            Some("BITMAP") => in_bitmap = true,
                            Some("ENDCHAR") => break,
                            Some(hex) if in_bitmap => rows.push(decode_hex(hex)?),
                            _ => {}
                        }
                    }
                    if let (Some(code), [width, height, x_off, y_off]) = (code, bbx.as_slice()) {
                        if let Ok(code) = u32::try_from(code) {
                            glyphs.insert(code, Glyph { advance, width: *width, height: *height, x_off: *x_off, y_off: *y_off, rows });
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(Font {
            height: height.ok_or("no FONTBOUNDINGBOX")?,
            box_width: box_width.ok_or("no FONTBOUNDINGBOX")?,
            ascent: ascent.ok_or("no FONT_ASCENT")?,
            glyphs,
        })
    }

    /// The glyph of a code point.
    #[must_use]
    pub fn glyph(&self, c: char) -> Option<&Glyph> {
        self.glyphs.get(&u32::from(c))
    }
}

fn ints<'a>(it: impl Iterator<Item = &'a str>) -> Result<Vec<i32>, String> {
    it.map(|t| t.parse::<i32>().map_err(|e| format!("bad number {t}: {e}"))).collect()
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err(format!("odd bitmap row {s}"));
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad bitmap row {s}: {e}"))).collect()
}

/// The two fonts of ABI 0.1, by id.
#[derive(Clone, Debug)]
pub struct Fonts {
    spleen_5x8: Font,
    spleen_8x16: Font,
}

impl Fonts {
    /// The embedded fonts.
    ///
    /// # Panics
    /// If the embedded BDF files do not parse (a build error of the repository).
    #[must_use]
    pub fn builtin() -> Fonts {
        Fonts {
            spleen_5x8: Font::parse(include_str!("../../../conformance/fonts/spleen-5x8.bdf")).expect("spleen-5x8.bdf"),
            spleen_8x16: Font::parse(include_str!("../../../conformance/fonts/spleen-8x16.bdf")).expect("spleen-8x16.bdf"),
        }
    }

    /// A font by its ABI id (1 or 2).
    #[must_use]
    pub fn get(&self, id: i32) -> Option<&Font> {
        match id {
            1 => Some(&self.spleen_5x8),
            2 => Some(&self.spleen_8x16),
            _ => None,
        }
    }
}

/// One step of a string: a code point, or one byte that is not part of a well-formed sequence.
fn steps(bytes: &[u8]) -> impl Iterator<Item = Option<char>> + '_ {
    bytes.utf8_chunks().flat_map(|chunk| {
        let valid = chunk.valid().chars().map(Some);
        let invalid = chunk.invalid().iter().map(|_| None);
        valid.chain(invalid)
    })
}

/// The advance of `bytes` in `font`, without drawing.
#[must_use]
pub fn text_width(font: &Font, bytes: &[u8]) -> i32 {
    steps(bytes).fold(0i32, |w, s| w.saturating_add(s.and_then(|c| font.glyph(c)).map_or(font.box_width, |g| g.advance)))
}

/// Calls `set(x, y)` for each pixel the glyphs of `bytes` set, with the first cell's top-left at
/// `(x, y)`. Returns the advance.
pub fn draw_text(font: &Font, x: i32, y: i32, bytes: &[u8], mut set: impl FnMut(i64, i64)) -> i32 {
    let mut pen = i64::from(x);
    for s in steps(bytes) {
        match s.and_then(|c| font.glyph(c)) {
            Some(g) => {
                let top = i64::from(y) + i64::from(font.ascent - g.y_off - g.height);
                for row in 0..usize::try_from(g.height).unwrap_or(0) {
                    for col in 0..usize::try_from(g.width).unwrap_or(0) {
                        if g.bit(col, row) {
                            set(pen + i64::from(g.x_off) + i64::try_from(col).unwrap_or(0), top + i64::try_from(row).unwrap_or(0));
                        }
                    }
                }
                pen += i64::from(g.advance);
            }
            None => pen += i64::from(font.box_width),
        }
    }
    i32::try_from(pen - i64::from(x)).unwrap_or(i32::MAX)
}
