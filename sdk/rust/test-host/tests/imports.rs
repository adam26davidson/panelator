//! Tests of the host imports of the document (modules written in WAT).

mod common;

use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use common::Wat;
use panelator_test_host::host::{Asset, Assets, Instance, Setup};
use panelator_test_host::raster::Layer;

const WHITE: u32 = 0xFFFF_FFFF;

fn escape(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        write!(s, "\\{b:02x}").unwrap();
        s
    })
}

fn imports() -> String {
    [
        r#"(import "panelator" "draw_text" (func $draw_text (param i32 i32 i32 i32 i32 i32) (result i32)))"#,
        r#"(import "panelator" "text_width" (func $text_width (param i32 i32 i32) (result i32)))"#,
        r#"(import "panelator" "font_height" (func $font_height (param i32) (result i32)))"#,
        r#"(import "panelator" "draw_image" (func $draw_image (param i32 i32 i32 i32 i32) (result i32)))"#,
        r#"(import "panelator" "config_len" (func $config_len (result i32)))"#,
        r#"(import "panelator" "config_read" (func $config_read (param i32 i32) (result i32)))"#,
        r#"(import "panelator" "time_unix_ms" (func $time_unix_ms (result i64)))"#,
        r#"(import "panelator" "time_utc_offset_s" (func $time_utc_offset_s (result i32)))"#,
        r#"(import "panelator" "random_u32" (func $random_u32 (result i32)))"#,
        r#"(import "panelator" "draw_pixel" (func $draw_pixel (param i32 i32 i32)))"#,
    ]
    .join("\n")
}

/// A module whose init runs `init`, with `data` (a string) at address 16.
fn module(data: &[u8], init: &str) -> Vec<u8> {
    Wat {
        imports: imports(),
        data: format!("(data (i32.const 16) \"{}\")", escape(data)),
        init: init.into(),
        ..Wat::default()
    }
    .bytes()
}

fn run_init(
    wasm: &[u8],
    w: usize,
    h: usize,
    assets: Assets,
    config: &str,
) -> Result<Instance, String> {
    let mut i = Instance::new(
        wasm,
        Setup {
            width: w,
            height: h,
            config: config.as_bytes().to_vec(),
            assets: Rc::new(assets),
            ..Setup::minimal()
        },
    )
    .map_err(|e| e.to_string())?;
    i.init(1_798_757_998_000, 3600)?;
    Ok(i)
}

#[allow(
    clippy::cast_possible_wrap,
    reason = "test layers are a few pixels across"
)]
fn lit(l: &Layer, color: u32) -> BTreeSet<(i64, i64)> {
    (0..l.height as i64)
        .flat_map(|y| (0..l.width as i64).map(move |x| (x, y)))
        .filter(|&(x, y)| l.get(x, y) == Some(color))
        .collect()
}

/// An independent reading of a BDF file: code point to (dwidth, bbx, rows), plus ascent.
#[allow(clippy::type_complexity, reason = "a one-off tuple in a test helper")]
fn bdf(text: &str) -> (i32, HashMap<u32, (i32, [i32; 4], Vec<u32>)>) {
    let mut ascent = 0;
    let mut out = HashMap::new();
    let mut cur: Option<(u32, i32, [i32; 4], Vec<u32>)> = None;
    let mut in_bitmap = false;
    for line in text.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "FONT_ASCENT" => ascent = f[1].parse().unwrap(),
            "STARTCHAR" => cur = Some((0, 0, [0; 4], vec![])),
            "ENCODING" => cur.as_mut().unwrap().0 = f[1].parse().unwrap(),
            "DWIDTH" => cur.as_mut().unwrap().1 = f[1].parse().unwrap(),
            "BBX" => {
                cur.as_mut().unwrap().2 = [
                    f[1].parse().unwrap(),
                    f[2].parse().unwrap(),
                    f[3].parse().unwrap(),
                    f[4].parse().unwrap(),
                ];
            }
            "BITMAP" => in_bitmap = true,
            "ENDCHAR" => {
                in_bitmap = false;
                let c = cur.take().unwrap();
                out.insert(c.0, (c.1, c.2, c.3));
            }
            hex if in_bitmap => {
                // a row of 1 or 2 bytes, left aligned in the integer's top bits
                let v = u32::from_str_radix(hex, 16).unwrap();
                cur.as_mut().unwrap().3.push(v << (32 - 4 * hex.len()));
            }
            _ => {}
        }
    }
    (ascent, out)
}

#[allow(
    clippy::many_single_char_names,
    reason = "x, y, r, h and w are the BDF and pixel coordinates"
)]
#[allow(clippy::cast_possible_wrap, reason = "glyph rows are at most 16")]
fn expected_pixels(font: i32, s: &str, x: i64, y: i64) -> (BTreeSet<(i64, i64)>, i64) {
    let file = if font == 1 {
        "spleen-5x8.bdf"
    } else {
        "spleen-8x16.bdf"
    };
    let text = std::fs::read_to_string(format!(
        "{}/../../conformance/fonts/{file}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let (ascent, glyphs) = bdf(&text);
    let (mut pen, mut set) = (x, BTreeSet::new());
    for c in s.chars() {
        let (adv, [w, h, xo, yo], rows) = glyphs[&(c as u32)].clone();
        for (r, bits) in rows.iter().enumerate() {
            for col in 0..w {
                if bits & (0x8000_0000 >> col) != 0 {
                    set.insert((
                        pen + i64::from(xo + col),
                        y + i64::from(ascent - yo - h) + r as i64,
                    ));
                }
            }
        }
        pen += i64::from(adv);
    }
    (set, pen - x)
}

fn draw_text_call(font: i32, x: i32, y: i32, s: &[u8]) -> String {
    format!(
        "(call $draw_pixel (i32.const 199) (i32.const 39) (call $draw_text (i32.const {font}) (i32.const {x}) (i32.const {y}) (i32.const 16) (i32.const {}) (i32.const -1)))",
        s.len()
    )
}

#[test]
fn every_printable_ascii_character_matches_the_bdf_bitmaps_in_both_fonts() {
    for font in [1, 2] {
        let s: String = (0x20u8..=0x7E).map(char::from).collect();
        for c in s.chars() {
            let one = c.to_string();
            let i = run_init(
                &module(one.as_bytes(), &draw_text_call(font, 3, 2, one.as_bytes())),
                200,
                40,
                Assets::new(),
                "{}",
            )
            .unwrap();
            let (want, advance) = expected_pixels(font, &one, 3, 2);
            let mut got = lit(i.layer(), WHITE);
            got.remove(&(199, 39));
            assert_eq!(got, want, "font {font} {c:?}");
            assert_eq!(i64::from(i.layer().get(199, 39).unwrap()), advance);
        }
        // the whole string at once: pen advances by each glyph
        let i = run_init(
            &module(s.as_bytes(), &draw_text_call(font, 0, 0, s.as_bytes())),
            200,
            40,
            Assets::new(),
            "{}",
        )
        .unwrap();
        let (want, advance) = expected_pixels(font, &s, 0, 0);
        assert_eq!(i64::from(i.layer().get(199, 39).unwrap()), advance);
        let got: BTreeSet<_> = lit(i.layer(), WHITE)
            .into_iter()
            .filter(|p| p.0 < 199 || p.1 < 39)
            .collect();
        assert_eq!(
            got.into_iter()
                .filter(|p| p.0 < 199)
                .collect::<BTreeSet<_>>(),
            want.into_iter()
                .filter(|p| p.0 < 199 && p.1 < 40)
                .collect::<BTreeSet<_>>()
        );
    }
}

#[test]
fn text_is_clipped_at_each_edge_like_a_window_onto_the_unclipped_text() {
    let s = b"Aq%y";
    for (x, y) in [
        (-6, 1),
        (0, -5),
        (3, 1),
        (8, 4),
        (20, 2),
        (4, -12),
        (-30, 0),
        (5, 14),
    ] {
        let clean = format!(
            "(drop (call $draw_text (i32.const 1) (i32.const {x}) (i32.const {y}) (i32.const 16) (i32.const 4) (i32.const -1)))"
        );
        let small = run_init(&module(s, &clean), 24, 12, Assets::new(), "{}").unwrap();
        let (want, _) = expected_pixels(1, "Aq%y", i64::from(x), i64::from(y));
        let want: BTreeSet<_> = want
            .into_iter()
            .filter(|p| (0..24).contains(&p.0) && (0..12).contains(&p.1))
            .collect();
        assert_eq!(lit(small.layer(), WHITE), want, "at ({x}, {y})");
    }
}

#[test]
fn a_missing_glyph_a_malformed_byte_and_an_unknown_font() {
    // U+4E2D has no glyph; each of 0xFF and the truncated E2 82 counts per byte.
    let s = "A\u{4e2d}B".as_bytes();
    let i = run_init(
        &module(s, &draw_text_call(1, 0, 0, s)),
        200,
        40,
        Assets::new(),
        "{}",
    )
    .unwrap();
    assert_eq!(
        i.layer().get(199, 39),
        Some(5 + 5 + 5),
        "the missing glyph advances by the box width"
    );
    let (a, _) = expected_pixels(1, "A", 0, 0);
    let (b, _) = expected_pixels(1, "B", 10, 0);
    let got: BTreeSet<_> = lit(i.layer(), WHITE)
        .into_iter()
        .filter(|p| p.0 < 199)
        .collect();
    assert_eq!(got, a.union(&b).copied().collect::<BTreeSet<_>>());
    let bad = [b'A', 0xFF, 0xE2, 0x82, b'B'];
    let i = run_init(
        &module(&bad, &draw_text_call(2, 0, 0, &bad)),
        200,
        40,
        Assets::new(),
        "{}",
    )
    .unwrap();
    assert_eq!(
        i.layer().get(199, 39),
        Some(8 * 5),
        "three ill-formed bytes advance by the box width each"
    );
    let i = run_init(
        &module(b"A", &draw_text_call(3, 0, 0, b"A")),
        200,
        40,
        Assets::new(),
        "{}",
    )
    .unwrap();
    assert_eq!(i.layer().get(199, 39), Some(u32::MAX), "unknown font: -1");
    assert_eq!(lit(i.layer(), WHITE).len(), 1, "and nothing drawn");
}

#[test]
fn text_width_and_font_height() {
    let init = "(call $draw_pixel (i32.const 0) (i32.const 0) (call $text_width (i32.const 2) (i32.const 16) (i32.const 15)))
                (call $draw_pixel (i32.const 1) (i32.const 0) (call $font_height (i32.const 1)))
                (call $draw_pixel (i32.const 2) (i32.const 0) (call $font_height (i32.const 2)))
                (call $draw_pixel (i32.const 3) (i32.const 0) (call $font_height (i32.const 9)))
                (call $draw_pixel (i32.const 4) (i32.const 0) (call $text_width (i32.const 9) (i32.const 16) (i32.const 1)))";
    let i = run_init(&module(b"panelator 60 Hz", init), 8, 1, Assets::new(), "{}").unwrap();
    let px: Vec<u32> = (0..5).map(|x| i.layer().get(x, 0).unwrap()).collect();
    assert_eq!(px, [15 * 8, 8, 16, u32::MAX, u32::MAX]);
}

fn two_frame_asset() -> Assets {
    // 3 by 2 pixels, two frames; the pixel's red channel says frame and position.
    let mut data = vec![];
    for frame in 0..2u8 {
        for p in 0..6u8 {
            data.extend([frame * 100 + p, 7, 9]);
        }
    }
    Assets::from([(
        "pic".to_string(),
        Asset {
            width: 3,
            height: 2,
            frames: 2,
            data,
        },
    )])
}

fn blit(frame: i32, x: i32, y: i32, name: &str) -> Instance {
    let init = format!(
        "(call $draw_pixel (i32.const 7) (i32.const 7) (call $draw_image (i32.const 16) (i32.const {}) (i32.const {frame}) (i32.const {x}) (i32.const {y})))",
        name.len()
    );
    run_init(
        &module(name.as_bytes(), &init),
        8,
        8,
        two_frame_asset(),
        "{}",
    )
    .unwrap()
}

fn rgb(r: u8) -> u32 {
    u32::from_be_bytes([r, 7, 9, 255])
}

#[test]
fn blit_inside_across_each_edge_and_outside() {
    let i = blit(0, 2, 3, "pic");
    assert_eq!(i.layer().get(2, 3), Some(rgb(0)));
    assert_eq!(i.layer().get(4, 4), Some(rgb(5)));
    assert_eq!(
        i.layer().get(7, 7),
        Some(0),
        "the return value 0 was drawn as colour 0"
    );
    assert_eq!(lit_any(i.layer()), 6);
    // across the left and top edges: the pixels at layer (0,0), (1,0) are asset (2,1), ...
    let i = blit(0, -2, -1, "pic");
    assert_eq!(i.layer().get(0, 0), Some(rgb(5)));
    assert_eq!(lit_any(i.layer()), 1);
    // across the right and bottom edges
    let i = blit(0, 6, 6, "pic");
    assert_eq!(i.layer().get(6, 6), Some(rgb(0)));
    assert_eq!(i.layer().get(7, 6), Some(rgb(1)));
    assert_eq!(i.layer().get(6, 7), Some(rgb(3)));
    assert_eq!(
        lit_any(i.layer()),
        3,
        "four pixels, but (7, 7) then holds the return value"
    );
    for (x, y) in [
        (8, 0),
        (-3, 0),
        (0, 8),
        (0, -2),
        (i32::MAX, i32::MAX),
        (i32::MIN, 0),
    ] {
        assert_eq!(
            lit_any(blit(0, x, y, "pic").layer()),
            0,
            "outside at ({x},{y})"
        );
    }
}

fn lit_any(l: &Layer) -> usize {
    l.pixels
        .iter()
        .enumerate()
        .filter(|(i, p)| **p != 0 && *i != 63)
        .count()
}

#[test]
fn the_second_frame_and_both_errors() {
    let i = blit(1, 0, 0, "pic");
    assert_eq!(i.layer().get(0, 0), Some(rgb(100)));
    assert_eq!(i.layer().get(2, 1), Some(rgb(105)));
    let i = blit(0, 0, 0, "nope");
    assert_eq!(
        i.layer().get(7, 7),
        Some(u32::MAX),
        "-1 for an unknown name"
    );
    assert_eq!(lit_any(i.layer()), 0);
    for frame in [2, -1] {
        let i = blit(frame, 0, 0, "pic");
        assert_eq!(
            i.layer().get(7, 7),
            Some(0xFFFF_FFFE),
            "-2 when the frame does not exist"
        );
        assert_eq!(lit_any(i.layer()), 0);
    }
}

#[test]
fn config_with_and_without_a_document_and_a_small_cap() {
    let init = "(call $draw_pixel (i32.const 0) (i32.const 0) (call $config_len))
                (call $draw_pixel (i32.const 1) (i32.const 0) (call $config_read (i32.const 100) (i32.const 3)))
                (call $draw_pixel (i32.const 2) (i32.const 0) (i32.load8_u (i32.const 100)))
                (call $draw_pixel (i32.const 3) (i32.const 0) (i32.load8_u (i32.const 102)))
                (call $draw_pixel (i32.const 4) (i32.const 0) (i32.load8_u (i32.const 103)))
                (call $draw_pixel (i32.const 5) (i32.const 0) (call $config_read (i32.const 200) (i32.const 1000)))
                (call $draw_pixel (i32.const 6) (i32.const 0) (call $config_read (i32.const 300) (i32.const -4)))";
    let w = module(b"", init);
    let i = run_init(&w, 8, 1, Assets::new(), r#"{"a":1}"#).unwrap();
    let px: Vec<u32> = (0..7).map(|x| i.layer().get(x, 0).unwrap()).collect();
    assert_eq!(px, [7, 3, u32::from(b'{'), u32::from(b'a'), 0, 7, 0]);
    let i = run_init(&w, 8, 1, Assets::new(), "{}").unwrap();
    assert_eq!(i.layer().get(0, 0), Some(2));
    assert_eq!(
        i.layer().get(1, 0),
        Some(2),
        "cap 3 of a 2 byte document copies 2"
    );
}

#[test]
fn time_timezone_and_the_random_sequence() {
    let init = "(call $draw_pixel (i32.const 0) (i32.const 0) (i32.wrap_i64 (call $time_unix_ms)))
                (call $draw_pixel (i32.const 1) (i32.const 0) (i32.wrap_i64 (i64.shr_u (call $time_unix_ms) (i64.const 32))))
                (call $draw_pixel (i32.const 2) (i32.const 0) (call $time_utc_offset_s))
                (call $draw_pixel (i32.const 3) (i32.const 0) (call $random_u32))
                (call $draw_pixel (i32.const 4) (i32.const 0) (call $random_u32))
                (call $draw_pixel (i32.const 5) (i32.const 0) (call $random_u32))";
    let mut i = Instance::new(
        &module(b"", init),
        Setup {
            width: 6,
            height: 1,
            seed: 2,
            ..Setup::minimal()
        },
    )
    .unwrap();
    i.init(1_798_757_998_000, 3600).unwrap();
    let px: Vec<u32> = (0..6).map(|x| i.layer().get(x, 0).unwrap()).collect();
    let ms = 1_798_757_998_000u64;
    assert_eq!(
        px,
        [
            u32::try_from(ms & 0xFFFF_FFFF).unwrap(),
            u32::try_from(ms >> 32).unwrap(),
            3600,
            540_738,
            134_253_570,
            697_882_754
        ]
    );
    let doc = std::fs::read_to_string(format!(
        "{}/../../../docs/widget-abi.md",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    for needle in [
        "540738, 134253570 and 697882754",
        "270369, 67634689 and 2647435461",
        "811107, 201886211 and 3025432647",
    ] {
        assert!(doc.contains(needle), "the document gives {needle}");
    }
    assert_eq!(panelator_test_host::abi::xorshift32(1), 270_369);
    assert_eq!(panelator_test_host::abi::xorshift32(3), 811_107);
}

#[test]
fn a_bad_pointer_is_a_trap_for_draw_text_draw_image_and_config_read() {
    for init in [
        "(drop (call $draw_text (i32.const 1) (i32.const 0) (i32.const 0) (i32.const 65530) (i32.const 100) (i32.const -1)))",
        "(drop (call $draw_text (i32.const 1) (i32.const 0) (i32.const 0) (i32.const -1) (i32.const 1) (i32.const -1)))",
        "(drop (call $draw_text (i32.const 1) (i32.const 0) (i32.const 0) (i32.const 16) (i32.const -1) (i32.const -1)))",
        "(drop (call $text_width (i32.const 1) (i32.const 65536) (i32.const 1)))",
        "(drop (call $draw_image (i32.const 65535) (i32.const 2) (i32.const 0) (i32.const 0) (i32.const 0)))",
        "(drop (call $config_read (i32.const 65535) (i32.const 2)))",
        "(drop (call $config_read (i32.const 65530) (i32.const 100)))",
    ] {
        let e = run_init(&module(b"", init), 4, 4, Assets::new(), r#"{"a":1}"#)
            .err()
            .expect("a trap");
        assert!(e.contains("outside the module's memory"), "{init}: {e}");
    }
    // At the very end of memory is fine.
    assert!(
        run_init(
            &module(
                b"",
                "(drop (call $config_read (i32.const 65530) (i32.const 6)))"
            ),
            4,
            4,
            Assets::new(),
            r#"{"a":1}"#
        )
        .is_ok()
    );
}
