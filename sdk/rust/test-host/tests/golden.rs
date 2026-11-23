//! The conformance suite as run by the reference host: the golden frames of `sdk/conformance/`,
//! its consistency, and the three-way agreement of the document, the host and the SDK.
//!
//! The golden tests need the spike modules (`sdk/rust/build-widgets.sh`); without them they fail,
//! they do not skip. With `PANELATOR_BLESS=1` they write the golden files instead of comparing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use panelator_test_host::abi::{IMPORTS, signature};
use panelator_test_host::conformance::spike_image;
use panelator_test_host::frame::Frame;
use panelator_test_host::host::{Instance, Setup};
use panelator_test_host::scene::{FramesJson, Run, Scene, run};
use panelator_test_host::tool::{self, dir_loader};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

fn conformance() -> PathBuf {
    root().join("sdk/conformance")
}

fn modules() -> PathBuf {
    root().join("target/widgets")
}

fn bless() -> bool {
    std::env::var("PANELATOR_BLESS").is_ok_and(|v| v == "1")
}

const SCENES: [&str; 4] = ["spike-clock", "spike-scroll", "spike-image", "spike"];
const MODULES: [&str; 3] = ["spike-clock", "spike-scroll", "spike-image"];

fn run_scene(name: &str) -> (Scene, Run) {
    for m in MODULES {
        assert!(modules().join(format!("{m}.wasm")).exists(), "the spike modules are not built: run sdk/rust/build-widgets.sh ({m}.wasm is missing)");
    }
    let scene = Scene::load(&conformance().join(format!("scenes/{name}.json"))).unwrap();
    let r = run(&scene, &mut dir_loader(&modules()), 10_000_000);
    assert!(r.error.is_none(), "{}", r.error.unwrap());
    (scene, r)
}

fn golden_test(name: &str) {
    let (scene, r) = run_scene(name);
    let dir = conformance().join("golden").join(name);
    if bless() {
        let _ = std::fs::remove_dir_all(&dir);
        tool::write_frames(&dir, &scene, &r.frames).unwrap();
        return;
    }
    let c = tool::compare(&r.frames, &dir);
    assert!(c.ok, "scene {name}: {}", c.report);
    let want: FramesJson = serde_json::from_str(&std::fs::read_to_string(dir.join("frames.json")).unwrap()).unwrap();
    assert_eq!(FramesJson::of(&scene, &r.frames), want, "scene {name}: frames.json");
}

#[test]
fn golden_spike_clock() {
    golden_test("spike-clock");
}

#[test]
fn golden_spike_scroll() {
    golden_test("spike-scroll");
}

#[test]
fn golden_spike_image() {
    golden_test("spike-image");
}

#[test]
fn golden_spike() {
    golden_test("spike");
}

#[test]
fn the_spike_image_asset_is_its_formula() {
    let path = conformance().join("assets/spike-image.rgb");
    if bless() && !path.exists() {
        std::fs::write(&path, spike_image()).unwrap();
    }
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 24_576);
    assert_eq!(bytes, spike_image());
    assert_eq!(&bytes[..3], [0, 0, 255]);
    let o = (63 * 128 + 127) * 3;
    assert_eq!(&bytes[o..o + 3], [255, 255, 255 * u8::from((15 + 7) % 2 == 0)]);
}

#[test]
fn the_golden_directory_is_consistent_with_the_scenes() {
    for name in SCENES {
        let scene = Scene::load(&conformance().join(format!("scenes/{name}.json"))).unwrap();
        let dir = conformance().join("golden").join(name);
        let json: FramesJson = serde_json::from_str(&std::fs::read_to_string(dir.join("frames.json")).unwrap()).unwrap();
        assert_eq!(json.scene, name);
        assert_eq!((json.panel["width"], json.panel["height"]), (scene.width, scene.height));
        assert_eq!(json.frames.iter().map(|f| f.tick).collect::<Vec<_>>(), scene.ticks, "{name}: frames.json lists the captured ticks");
        let mut pngs = BTreeSet::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let file = entry.unwrap().file_name().into_string().unwrap();
            if file != "frames.json" {
                pngs.insert(file);
            }
        }
        let want: BTreeSet<String> = scene.ticks.iter().map(|t| format!("tick-{t}.png")).collect();
        assert_eq!(pngs, want, "{name}: a golden file for each captured tick and no other");
        for f in &json.frames {
            let png = Frame::read_png(&dir.join(format!("tick-{}.png", f.tick))).unwrap();
            assert_eq!((png.width, png.height), (scene.width, scene.height));
            assert_eq!(png.sha256(), f.sha256, "{name} tick {}: the PNG's pixels and its hash agree", f.tick);
        }
    }
}

#[test]
fn the_conformance_directory_names_its_fonts_and_readme() {
    let c = conformance();
    for f in ["README.md", "fonts/spleen-5x8.bdf", "fonts/spleen-8x16.bdf", "fonts/LICENSE-spleen"] {
        assert!(c.join(f).exists(), "{f}");
    }
    assert!(std::fs::read_to_string(c.join("fonts/spleen-5x8.bdf")).unwrap().contains("Spleen 5x8 2.3.0"));
    assert!(std::fs::read_to_string(c.join("README.md")).unwrap().contains("2.3.0"));
}

#[test]
fn the_spike_image_scene_shows_the_asset_at_tick_0_and_wraps_at_tick_256() {
    let (_, r) = run_scene("spike-image");
    let tick = |t: u64| &r.frames.iter().find(|f| f.0 == t).unwrap().1;
    assert_eq!(tick(0).rgb, spike_image());
    assert_eq!(tick(256), tick(0));
    assert_ne!(tick(2), tick(0), "the image has moved after two ticks");
}

fn doc_import_signatures() -> Vec<(String, String)> {
    let doc = std::fs::read_to_string(root().join("docs/widget-abi.md")).unwrap();
    let mut out = vec![];
    for line in doc.lines().filter(|l| l.starts_with("| `panelator` |")) {
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        let name = cells[1].trim_matches('`').to_string();
        let params: Vec<&str> = cells[2].trim_matches('`').split(',').map(|p| p.rsplit(':').next().unwrap().trim()).filter(|p| !p.is_empty()).collect();
        let result = cells[3].trim_matches('`');
        out.push((name, format!("({})->{}", params.join(","), if result.is_empty() { "()" } else { result })));
    }
    out
}

fn sdk_import_signatures() -> Vec<(String, String)> {
    let src = std::fs::read_to_string(root().join("sdk/rust/panelator-widget/src/sys.rs")).unwrap();
    src.lines()
        .filter_map(|l| l.trim().strip_prefix("pub fn "))
        .map(|l| {
            let (head, ret) = l.trim_end_matches(';').split_once(" -> ").map_or((l.trim_end_matches(';'), "()"), |(h, r)| (h, r));
            let (name, args) = head.split_once('(').unwrap();
            let params: Vec<&str> = args.trim_end_matches(')').split(',').map(|p| p.rsplit(':').next().unwrap().trim()).filter(|p| !p.is_empty()).collect();
            (name.to_string(), format!("({})->{ret}", params.join(",")))
        })
        .collect()
}

#[test]
fn the_document_the_host_and_the_sdk_name_the_same_imports_with_the_same_signatures() {
    let mut host: Vec<(String, String)> = IMPORTS.iter().map(|f| (f.name.to_string(), signature(f))).collect();
    let (mut doc, mut sdk) = (doc_import_signatures(), sdk_import_signatures());
    assert_eq!(doc.len(), 16);
    host.sort();
    doc.sort();
    sdk.sort();
    assert_eq!(doc, host, "document against host");
    assert_eq!(sdk, host, "SDK against host");
    // The functions the host registers are exactly that list.
    let engine = wasmi::Engine::default();
    let mut linker = wasmi::Linker::<panelator_test_host::host::State>::new(&engine);
    let mut registered: Vec<String> = panelator_test_host::host::register(&mut linker).unwrap().into_iter().map(String::from).collect();
    registered.sort();
    assert_eq!(registered, host.iter().map(|h| h.0.clone()).collect::<Vec<_>>());
}

#[test]
fn the_spike_modules_load_are_small_and_import_exactly_the_abi_between_them() {
    let mut union = BTreeSet::new();
    for m in MODULES {
        let path = modules().join(format!("{m}.wasm"));
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("the spike modules are not built (sdk/rust/build-widgets.sh): {}: {e}", path.display()));
        assert!(bytes.len() <= 64 * 1024, "{m} is {} bytes", bytes.len());
        let i = Instance::new(&bytes, Setup::minimal()).unwrap_or_else(|e| panic!("{m}: {e}"));
        assert_eq!(i.info.abi_version, 1);
        union.extend(i.info.imports);
    }
    let all: BTreeSet<String> = IMPORTS.iter().map(|f| format!("panelator.{}", f.name)).collect();
    assert_eq!(union, all);
}

#[test]
fn the_declarations_of_the_spike_modules_are_those_of_the_spec() {
    let want = [("spike-clock", 1, 64, 32), ("spike-scroll", 60, 128, 16), ("spike-image", 30, 128, 64)];
    for (m, hz, w, h) in want {
        let bytes = std::fs::read(modules().join(format!("{m}.wasm"))).expect("the spike modules are not built (sdk/rust/build-widgets.sh)");
        let i = Instance::new(&bytes, Setup::minimal()).unwrap();
        assert_eq!((i.info.update_hz, i.info.width, i.info.height), (hz, w, h), "{m}");
    }
}
