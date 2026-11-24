//! The bytes of a placement's config (spec 116 AC-1, AC-6, AC-7, AC-9).

mod common;

use std::path::Path;

use common::Wat;
use panelator_test_host::config::canonical;
use panelator_test_host::scene::{Scene, run};
use serde_json::{Map, Value};

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/config/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors.json")).expect("JSON")
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().expect(key).to_string()
}

#[test]
fn each_vector_has_the_canonical_form_and_each_rejected_config_fails() {
    let v = vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 11 + 22, "the file holds the AC-9 vectors");
    for c in cases {
        let config: Map<String, Value> =
            serde_json::from_str(&text(c, "config")).unwrap_or_else(|e| panic!("{c}: {e}"));
        let got = canonical(&config).unwrap();
        assert_eq!(
            String::from_utf8(got).unwrap(),
            text(c, "canonical"),
            "{}",
            text(c, "name")
        );
    }
    let rejected = v["rejected"].as_array().unwrap();
    assert!(rejected.len() >= 2);
    for r in rejected {
        let failed = serde_json::from_str::<Map<String, Value>>(&text(r, "config"))
            .map_err(|e| e.to_string())
            .and_then(|m| canonical(&m))
            .is_err();
        assert!(failed, "{} is refused", text(r, "name"));
    }
}

fn scene_with_config(config: &str) -> String {
    format!(
        r#"{{"abi": "0.1", "panel": {{"width": 16, "height": 1}}, "start_unix_ms": 0, "utc_offset_s": 0, "ticks": [0], "assets": [], "placements": [{{"module": "m", "x": 0, "y": 0, "width": 16, "height": 1, "z": 0, "opacity": 255, "config": {config}, "seed": 1}}]}}"#
    )
}

fn parse(config: &str) -> Result<Scene, String> {
    Scene::from_json("t", &scene_with_config(config), Path::new("/nonexistent"))
}

#[test]
fn a_module_reads_the_canonical_bytes_of_the_scene_files_config() {
    let imports = r#"(import "panelator" "draw_pixel" (func $px (param i32 i32 i32)))
        (import "panelator" "config_len" (func $len (result i32)))
        (import "panelator" "config_read" (func $read (param i32 i32) (result i32)))"#;
    // Pixel 0 shows config_len, pixel 1 + i the byte i, each in the red channel.
    let mut init = String::from(
        "(call $px (i32.const 0) (i32.const 0) (i32.or (i32.shl (call $len) (i32.const 24)) (i32.const 255)))
         (drop (call $read (i32.const 100) (i32.const 13)))",
    );
    for i in 0..13 {
        init += &format!(
            "(call $px (i32.const {}) (i32.const 0) (i32.or (i32.shl (i32.load8_u (i32.const {})) (i32.const 24)) (i32.const 255)))",
            i + 1,
            100 + i
        );
    }
    let wasm = Wat {
        imports: imports.into(),
        init,
        width: 16,
        height: 1,
        ..Wat::default()
    }
    .bytes();
    let scene = parse(r#"{ "b": 1, "a": 2 }"#).unwrap();
    let r = run(&scene, &mut |_| Ok(wasm.clone()), 1_000_000);
    assert!(r.error.is_none(), "{:?}", r.error);
    let frame = &r.frames[0].1;
    let want = br#"{"a":2,"b":1}"#;
    assert_eq!(frame.pixel(0, 0)[0], 13, "config_len is 13");
    let got: Vec<u8> = (1..=13).map(|x| frame.pixel(x, 0)[0]).collect();
    assert_eq!(got, want);
}

#[test]
fn a_config_that_is_not_a_config_fails_the_scene_naming_the_placement() {
    for bad in [r#"{"a":1e400}"#, r#"{"a":"\ud800"}"#, "[1]"] {
        let e = parse(bad).unwrap_err();
        assert!(e.contains("placements[0].config"), "{bad}: {e}");
    }
    assert!(parse(r#"{"a":1,"a":2}"#).is_ok());
}
