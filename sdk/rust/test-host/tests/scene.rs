//! Tests of scenes, stepping, composition and the commands (modules written in WAT).

mod common;

use std::path::{Path, PathBuf};

use common::Wat;

/// A table of named module builders.
type Modules = &'static [(&'static str, fn() -> Vec<u8>)];
/// A composition case: opacity, then (alpha, expected RGB) pairs.
type Case = (u32, [(u32, [u8; 3]); 2]);
use panelator_test_host::frame::Frame;
use panelator_test_host::raster::Layer;
use panelator_test_host::scene::{FramesJson, Scene, compose, run, time_at};
use panelator_test_host::tool;

const FILL: &str = r#"(import "panelator" "draw_fill" (func $draw_fill (param i32)))"#;

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("panelator-test-host-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A module that fills its layer with `color` at tick 0 and declares `w` by `h`.
fn filler(color: u32) -> Vec<u8> {
    Wat {
        imports: FILL.into(),
        init: format!("(call $draw_fill (i32.const {}))", color.cast_signed()),
        width: 4,
        height: 4,
        ..Wat::default()
    }
    .bytes()
}

#[allow(
    clippy::many_single_char_names,
    reason = "x, y, w, h and z are the scene fields"
)]
fn placement(module: &str, x: i32, y: i32, w: u32, h: u32, z: i32, opacity: u32) -> String {
    format!(
        r#"{{"module": "{module}", "x": {x}, "y": {y}, "width": {w}, "height": {h}, "z": {z}, "opacity": {opacity}, "config": {{}}, "seed": 1}}"#
    )
}

fn scene_json(panel: (u32, u32), ticks: &str, placements: &[String]) -> String {
    format!(
        r#"{{"abi": "0.1", "panel": {{"width": {}, "height": {}}}, "start_unix_ms": 1798757998000, "utc_offset_s": 3600, "ticks": {ticks}, "assets": [], "placements": [{}]}}"#,
        panel.0,
        panel.1,
        placements.join(",")
    )
}

fn load(modules: Modules) -> impl FnMut(&str) -> Result<Vec<u8>, String> {
    move |name| {
        modules
            .iter()
            .find(|m| m.0 == name)
            .map(|m| (m.1)())
            .ok_or(format!("no module {name}"))
    }
}

fn red() -> Vec<u8> {
    filler(0xFF00_00FF)
}
fn green() -> Vec<u8> {
    filler(0x00FF_00FF)
}

fn parse(text: &str) -> Result<Scene, String> {
    Scene::from_json("t", text, Path::new("/nonexistent"))
}

#[test]
fn scene_parsing_accepts_a_good_scene_and_rejects_each_fault_by_name() {
    let good = scene_json((8, 8), "[0, 5]", &[placement("red", 0, 0, 4, 4, 0, 255)]);
    assert!(parse(&good).is_ok());
    let e = parse(&good.replace("\"z\": 0,", "\"z\": 0, \"colour\": 1,")).unwrap_err();
    assert!(e.contains("unknown field") && e.contains("colour"), "{e}");
    let e = parse(&good.replace("\"seed\": 1", "\"sed\": 1")).unwrap_err();
    assert!(e.contains("sed") || e.contains("seed"), "{e}");
    let e = parse(&good.replace("\"utc_offset_s\": 3600, ", "")).unwrap_err();
    assert!(
        e.contains("missing field") && e.contains("utc_offset_s"),
        "{e}"
    );
    assert!(
        parse(&good.replace("\"opacity\": 255", "\"opacity\": 256"))
            .unwrap_err()
            .contains("opacity")
    );
    assert!(
        parse(&good.replace("\"seed\": 1", "\"seed\": 0"))
            .unwrap_err()
            .contains("seed")
    );
    assert!(
        parse(&good.replace("\"0.1\"", "\"0.2\""))
            .unwrap_err()
            .contains("abi")
    );
    assert!(
        parse(&good.replace("[0, 5]", "[5, 0]"))
            .unwrap_err()
            .contains("ticks")
    );
    assert!(parse(&good.replace("\"seed\": 1", "\"seed\": 4294967296")).is_err());
}

#[test]
fn asset_files_must_have_the_length_width_times_height_times_frames_times_3() {
    let dir = scratch("assets");
    std::fs::write(dir.join("a.rgb"), [0u8; 18]).unwrap();
    let text = |frames: u32| {
        scene_json((8, 8), "[0]", &[]).replace("\"assets\": []", &format!(r#""assets": [{{"name": "a", "file": "a.rgb", "width": 3, "height": 2, "frames": {frames}}}]"#))
    };
    assert!(Scene::from_json("t", &text(1), &dir).is_ok());
    let e = Scene::from_json("t", &text(2), &dir).unwrap_err();
    assert!(
        e.contains("a.rgb") && e.contains("18") && e.contains("36"),
        "{e}"
    );
}

#[test]
fn the_clock_of_each_tick_is_start_plus_tick_times_1000_over_60() {
    assert_eq!(time_at(1000, 0), 1000);
    assert_eq!(time_at(1000, 1), 1016);
    assert_eq!(time_at(1000, 60), 2000);
    assert_eq!(time_at(1000, 61), 2016);
    // And a module sees it: it draws (time - start) as colour in pixel (0, 0): low byte in R, next in G.
    let wat = Wat {
        imports: r#"(import "panelator" "draw_pixel" (func $draw_pixel (param i32 i32 i32)))
                    (import "panelator" "time_unix_ms" (func $t (result i64)))"#
            .into(),
        update: r"(local $d i32)
            (local.set $d (i32.wrap_i64 (i64.sub (call $t) (i64.const 1798757998000))))
            (call $draw_pixel (i32.const 0) (i32.const 0)
              (i32.or (i32.or (i32.shl (local.get $d) (i32.const 24))
                              (i32.shl (i32.and (i32.shr_u (local.get $d) (i32.const 8)) (i32.const 255)) (i32.const 16)))
                      (i32.const 255)))"
            .into(),
        hz: 60,
        ..Wat::default()
    }
    .bytes();
    let scene = parse(&scene_json(
        (2, 2),
        "[0, 1, 60, 61]",
        &[placement("clock", 0, 0, 2, 2, 0, 255)],
    ))
    .unwrap();
    let r = run(&scene, &mut |_| Ok(wat.clone()), 1_000_000);
    assert!(r.error.is_none());
    let px: Vec<[u8; 3]> = r.frames.iter().map(|f| f.1.pixel(0, 0)).collect();
    assert_eq!(px, [[0, 0, 0], [0x10, 0, 0], [0xE8, 3, 0], [0xF8, 3, 0]]);
}

/// The compositions of AC-11, with values computed by hand: the backdrop (200, 0, 255) and a layer pixel
/// (255, 10, 0) of alpha `pa` at layer opacity `op`.
#[test]
fn composition_with_alpha_and_opacity_against_hand_computed_values() {
    let cases: [Case; 6] = [
        (0, [(255, [200, 0, 255]), (128, [200, 0, 255])]),
        (1, [(255, [200, 0, 254]), (128, [200, 0, 254])]),
        (127, [(255, [227, 5, 128]), (128, [214, 3, 191])]),
        (128, [(255, [228, 5, 127]), (128, [214, 3, 191])]),
        (254, [(255, [255, 10, 1]), (128, [227, 5, 128])]),
        (255, [(255, [255, 10, 0]), (128, [228, 5, 127])]),
    ];
    for (opacity, rows) in cases {
        for (pa, want) in rows {
            let mut back = Layer::new(1, 1);
            back.set(0, 0, 0xC800_FFFF);
            let mut top = Layer::new(1, 1);
            top.set(0, 0, 0xFF0A_0000 | pa);
            let f = compose(1, 1, &[(&back, 0, 0, 255), (&top, 0, 0, opacity)]);
            assert_eq!(f.pixel(0, 0), want, "alpha {pa} opacity {opacity}");
        }
    }
    // a transparent layer pixel leaves the frame as it is, whatever the opacity
    let mut back = Layer::new(1, 1);
    back.set(0, 0, 0xC800_FFFF);
    let top = Layer::new(1, 1);
    assert_eq!(
        compose(1, 1, &[(&back, 0, 0, 255), (&top, 0, 0, 255)]).pixel(0, 0),
        [200, 0, 255]
    );
}

#[test]
fn layers_are_applied_in_ascending_z_with_ties_in_scene_order_and_clipped_to_the_panel() {
    fn mods() -> Modules {
        &[("red", red), ("green", green)]
    }
    // z decides, not scene order
    let a = parse(&scene_json(
        (6, 6),
        "[0]",
        &[
            placement("red", 0, 0, 4, 4, 5, 255),
            placement("green", 2, 2, 4, 4, 1, 255),
        ],
    ))
    .unwrap();
    let f = &run(&a, &mut load(mods()), 1_000_000).frames[0].1;
    assert_eq!(f.pixel(3, 3), [255, 0, 0], "red has the higher z");
    assert_eq!(f.pixel(5, 5), [0, 255, 0]);
    assert_eq!(f.pixel(0, 5), [0, 0, 0]);
    // ties: the later placement is on top
    let b = parse(&scene_json(
        (6, 6),
        "[0]",
        &[
            placement("red", 0, 0, 4, 4, 0, 255),
            placement("green", 2, 2, 4, 4, 0, 255),
        ],
    ))
    .unwrap();
    assert_eq!(
        run(&b, &mut load(mods()), 1_000_000).frames[0]
            .1
            .pixel(3, 3),
        [0, 255, 0]
    );
    // clipped at every edge: a layer hanging off the top-left and one off the bottom-right
    let c = parse(&scene_json(
        (3, 3),
        "[0]",
        &[
            placement("red", -2, -2, 4, 4, 0, 255),
            placement("green", 2, 2, 4, 4, 1, 255),
        ],
    ))
    .unwrap();
    let f = &run(&c, &mut load(mods()), 1_000_000).frames[0].1;
    let reds: Vec<_> = (0..3)
        .flat_map(|y| (0..3).map(move |x| (x, y)))
        .filter(|&(x, y)| f.pixel(x, y) == [255, 0, 0])
        .collect();
    assert_eq!(reds, [(0, 0), (1, 0), (0, 1), (1, 1)]);
    assert_eq!(f.pixel(2, 2), [0, 255, 0]);
}

#[test]
fn every_due_update_runs_before_the_frame_is_composed() {
    // A 60 Hz module paints its tick into its layer; the frame of tick t shows t, never t - 1.
    // (Placements share no state, so the order of updates within a tick is not observable here.)
    let wat = Wat {
        hz: 60,
        imports: r#"(import "panelator" "draw_fill" (func $f (param i32)))"#.into(),
        update: "(call $f (i32.shl (i32.wrap_i64 (local.get 0)) (i32.const 24)))\n(call $f (i32.or (i32.shl (i32.wrap_i64 (local.get 0)) (i32.const 24)) (i32.const 255)))".into(),
        ..Wat::default()
    }
    .bytes();
    let scene = parse(&scene_json(
        (1, 1),
        "[0, 1, 2, 7]",
        &[placement("m", 0, 0, 1, 1, 0, 255)],
    ))
    .unwrap();
    let r = run(&scene, &mut |_| Ok(wat.clone()), 1_000_000);
    let reds: Vec<u8> = r.frames.iter().map(|f| f.1.pixel(0, 0)[0]).collect();
    assert_eq!(reds, [0, 1, 2, 7]);
}

#[test]
fn a_trap_and_a_fuel_overrun_name_the_placement_export_and_tick_and_write_no_later_frame() {
    let trapper = Wat {
        hz: 60,
        update: "(if (i64.eq (local.get 0) (i64.const 3)) (then unreachable))".into(),
        ..Wat::default()
    }
    .bytes();
    let looper = Wat {
        hz: 60,
        update: "(if (i64.eq (local.get 0) (i64.const 2)) (then (loop $l (br $l))))".into(),
        ..Wat::default()
    }
    .bytes();
    let scene = parse(&scene_json(
        (1, 1),
        "[0, 1, 2, 3, 4]",
        &[
            placement("ok", 0, 0, 1, 1, 0, 255),
            placement("trap", 0, 0, 1, 1, 1, 255),
        ],
    ))
    .unwrap();
    let ok = Wat::default().bytes();
    let r = run(
        &scene,
        &mut |n| {
            Ok(if n == "ok" {
                ok.clone()
            } else {
                trapper.clone()
            })
        },
        1_000_000,
    );
    let e = r.error.unwrap();
    assert_eq!(
        (e.placement, e.export.as_str(), e.tick, e.module.as_str()),
        (1, "pn_update", 3, "trap")
    );
    assert_eq!(
        r.frames.iter().map(|f| f.0).collect::<Vec<_>>(),
        [0, 1, 2],
        "no frame for tick 3 or later"
    );
    let r = run(
        &scene,
        &mut |n| {
            Ok(if n == "ok" {
                ok.clone()
            } else {
                looper.clone()
            })
        },
        10_000,
    );
    let e = r.error.unwrap();
    assert_eq!((e.placement, e.tick), (1, 2));
    assert!(
        e.message.to_lowercase().contains("fuel") && e.to_string().contains("pn_update"),
        "{e}"
    );
    assert_eq!(r.frames.len(), 2);
    // a module that cannot load
    let r = run(&scene, &mut |_| Err("missing".into()), 1000);
    assert_eq!(r.error.unwrap().export, "load");
}

#[test]
fn two_runs_of_a_scene_are_byte_identical() {
    fn mods() -> Modules {
        &[("red", red), ("green", green)]
    }
    let scene = parse(&scene_json(
        (6, 6),
        "[0, 1]",
        &[
            placement("red", 0, 0, 4, 4, 5, 200),
            placement("green", 2, 2, 4, 4, 1, 255),
        ],
    ))
    .unwrap();
    let (a, b) = (
        run(&scene, &mut load(mods()), 1_000_000),
        run(&scene, &mut load(mods()), 1_000_000),
    );
    assert_eq!(a.frames, b.frames);
    let (da, db) = (scratch("a"), scratch("b"));
    tool::write_frames(&da, &scene, &a.frames).unwrap();
    tool::write_frames(&db, &scene, &b.frames).unwrap();
    for f in ["frames.json", "tick-0.png", "tick-1.png"] {
        assert_eq!(
            std::fs::read(da.join(f)).unwrap(),
            std::fs::read(db.join(f)).unwrap(),
            "{f}"
        );
    }
}

#[test]
fn run_writes_pngs_and_hashes_and_check_reports_the_first_difference() {
    let dir = scratch("cli");
    let modules = dir.join("modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(modules.join("red.wasm"), red()).unwrap();
    std::fs::write(modules.join("green.wasm"), green()).unwrap();
    let scene_path = dir.join("one.json");
    std::fs::write(
        &scene_path,
        scene_json((6, 6), "[0, 2]", &[placement("red", 1, 1, 4, 4, 0, 255)]),
    )
    .unwrap();
    let out = dir.join("out");
    tool::run_to_dir(&scene_path, &modules, &out, 1_000_000).unwrap();
    let json: FramesJson =
        serde_json::from_str(&std::fs::read_to_string(out.join("frames.json")).unwrap()).unwrap();
    assert_eq!(
        (
            json.scene.as_str(),
            json.panel["width"],
            json.panel["height"]
        ),
        ("one", 6, 6)
    );
    assert_eq!(json.frames.len(), 2);
    let png = Frame::read_png(&out.join("tick-2.png")).unwrap();
    assert_eq!(png.sha256(), json.frames[1].sha256);
    assert_eq!(png.pixel(1, 1), [255, 0, 0]);
    // check against itself passes; against a different scene it reports the first differing pixel
    let ok = tool::check(&scene_path, &modules, &out, None, 1_000_000).unwrap();
    assert!(ok.ok, "{}", ok.report);
    std::fs::write(
        &scene_path,
        scene_json((6, 6), "[0, 2]", &[placement("green", 2, 1, 4, 4, 0, 255)]),
    )
    .unwrap();
    let actual = dir.join("actual");
    let bad = tool::check(&scene_path, &modules, &out, Some(&actual), 1_000_000).unwrap();
    assert!(!bad.ok);
    assert_eq!(
        bad.report,
        "tick 0: first difference at (1, 1): got #000000, golden #ff0000"
    );
    assert!(actual.join("tick-0.png").exists() && actual.join("frames.json").exists());
    // a missing golden frame fails too
    std::fs::remove_file(out.join("tick-2.png")).unwrap();
    std::fs::write(
        &scene_path,
        scene_json((6, 6), "[0, 2]", &[placement("red", 1, 1, 4, 4, 0, 255)]),
    )
    .unwrap();
    assert!(
        !tool::check(&scene_path, &modules, &out, None, 1_000_000)
            .unwrap()
            .ok
    );
}

#[test]
fn the_binary_exits_0_on_a_match_1_on_a_difference_and_inspect_prints_the_declarations() {
    let dir = scratch("bin");
    let modules = dir.join("modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(modules.join("red.wasm"), red()).unwrap();
    let scene_path = dir.join("s.json");
    std::fs::write(
        &scene_path,
        scene_json((4, 4), "[0]", &[placement("red", 0, 0, 4, 4, 0, 255)]),
    )
    .unwrap();
    let exe = env!("CARGO_BIN_EXE_panelator-test-host");
    let run_cmd = |args: &[&str]| std::process::Command::new(exe).args(args).output().unwrap();
    let s = |p: &Path| p.to_str().unwrap().to_string();
    let (out, modules_s, scene_s) = (dir.join("out"), s(&modules), s(&scene_path));
    assert!(
        run_cmd(&[
            "run",
            &scene_s,
            "--modules",
            &modules_s,
            "--out",
            &s(&out),
            "--fuel",
            "100000"
        ])
        .status
        .success()
    );
    assert_eq!(
        run_cmd(&[
            "check",
            &scene_s,
            "--modules",
            &modules_s,
            "--golden",
            &s(&out)
        ])
        .status
        .code(),
        Some(0)
    );
    std::fs::write(
        &scene_path,
        scene_json((4, 4), "[0]", &[placement("red", 1, 0, 3, 4, 0, 255)]),
    )
    .unwrap();
    let r = run_cmd(&[
        "check",
        &scene_s,
        "--modules",
        &modules_s,
        "--golden",
        &s(&out),
    ]);
    assert_eq!(r.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&r.stderr).contains("tick 0: first difference at (0, 0)"));
    let r = run_cmd(&["inspect", &s(&modules.join("red.wasm"))]);
    let text = String::from_utf8_lossy(&r.stdout);
    assert!(
        text.contains("abi version: 0.1")
            && text.contains("size: 4 x 4")
            && text.contains("1 page"),
        "{text}"
    );
    std::fs::write(modules.join("bad.wasm"), b"nope").unwrap();
    assert!(
        String::from_utf8_lossy(&run_cmd(&["inspect", &s(&modules.join("bad.wasm"))]).stdout)
            .contains("load error")
    );
}

#[test]
fn the_panel_and_a_placement_are_bounded_and_the_bounds_are_inclusive() {
    let p = |w: u32, h: u32| placement("red", 0, 0, w, h, 0, 255);
    for panel in [(0, 1), (16385, 1), (1, 16385), (1, 0)] {
        let e = parse(&scene_json(panel, "[0]", &[p(4, 4)])).unwrap_err();
        assert!(e.contains("panel"), "{panel:?}: {e}");
    }
    for panel in [(16384, 1), (1, 16384)] {
        assert!(
            parse(&scene_json(panel, "[0]", &[p(4, 4)])).is_ok(),
            "{panel:?}"
        );
    }
    for (w, h) in [(0, 1), (4097, 1), (1, 4097), (1, 0)] {
        let e = parse(&scene_json((8, 8), "[0]", &[p(4, 4), p(w, h)])).unwrap_err();
        assert!(e.contains("placements[1]"), "{w}x{h}: {e}");
    }
    for (w, h) in [(4096, 1), (1, 4096)] {
        assert!(
            parse(&scene_json((8, 8), "[0]", &[p(w, h)])).is_ok(),
            "{w}x{h}"
        );
    }
}
