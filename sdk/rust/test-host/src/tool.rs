//! The commands of `panelator-test-host` as library functions: `run`, `check` and `inspect`.

use std::path::Path;

use crate::frame::Frame;
use crate::host::{Instance, Setup};
use crate::scene::{FramesJson, Run, Scene, run};

/// A loader that reads `<dir>/<name>.wasm`.
pub fn dir_loader(dir: &Path) -> impl FnMut(&str) -> Result<Vec<u8>, String> {
    let dir = dir.to_path_buf();
    move |name| {
        let path = dir.join(format!("{name}.wasm"));
        std::fs::read(&path).map_err(|e| format!("{}: {e} (build the modules with sdk/rust/build-widgets.sh)", path.display()))
    }
}

/// Writes `tick-<n>.png` for each frame and `frames.json` into `dir`.
///
/// # Errors
/// An I/O error as text.
pub fn write_frames(dir: &Path, scene: &Scene, frames: &[(u64, Frame)]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for (tick, frame) in frames {
        frame.write_png(&dir.join(format!("tick-{tick}.png")))?;
    }
    let json = serde_json::to_string_pretty(&FramesJson::of(scene, frames)).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("frames.json"), json + "\n").map_err(|e| format!("{}: {e}", dir.display()))
}

/// `run`: runs the scene and writes its frames. The frames before an error are written; none for
/// the tick of the error or later.
///
/// # Errors
/// The scene, I/O or run error as text.
pub fn run_to_dir(scene_path: &Path, modules: &Path, out: &Path, fuel: u64) -> Result<(), String> {
    let scene = Scene::load(scene_path)?;
    let Run { frames, error } = run(&scene, &mut dir_loader(modules), fuel);
    write_frames(out, &scene, &frames)?;
    error.map_or(Ok(()), |e| Err(e.to_string()))
}

/// What `check` found.
#[derive(Debug)]
pub struct Check {
    /// Whether every captured frame equals its golden frame.
    pub ok: bool,
    /// The report: empty when `ok`, else the first difference.
    pub report: String,
}

fn hex(p: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", p[0], p[1], p[2])
}

/// Compares a run's frames with the golden frames in `golden` (`tick-<n>.png`).
#[must_use]
pub fn compare(frames: &[(u64, Frame)], golden: &Path) -> Check {
    for (tick, frame) in frames {
        let path = golden.join(format!("tick-{tick}.png"));
        let want = match Frame::read_png(&path) {
            Ok(f) => f,
            Err(e) => return Check { ok: false, report: format!("tick {tick}: no golden frame: {e}") },
        };
        if let Some((x, y, got, expected)) = frame.first_difference(&want) {
            let size = if frame.width == want.width && frame.height == want.height {
                String::new()
            } else {
                format!(" (sizes differ: {}x{} against golden {}x{})", frame.width, frame.height, want.width, want.height)
            };
            return Check { ok: false, report: format!("tick {tick}: first difference at ({x}, {y}): got {}, golden {}{size}", hex(got), hex(expected)) };
        }
    }
    Check { ok: true, report: String::new() }
}

/// `check`: runs the scene and compares every captured frame with the golden frames. Given
/// `actual`, writes the frames produced there.
///
/// # Errors
/// The scene or I/O error as text; a run error is a failed check, reported in the result.
pub fn check(scene_path: &Path, modules: &Path, golden: &Path, actual: Option<&Path>, fuel: u64) -> Result<Check, String> {
    let scene = Scene::load(scene_path)?;
    let Run { frames, error } = run(&scene, &mut dir_loader(modules), fuel);
    if let Some(dir) = actual {
        write_frames(dir, &scene, &frames)?;
    }
    if let Some(e) = error {
        return Ok(Check { ok: false, report: format!("run failed: {e}") });
    }
    Ok(compare(&frames, golden))
}

/// `inspect`: a module's declarations, imports and memory size, or the load error.
#[must_use]
pub fn inspect(wasm: &[u8]) -> String {
    match Instance::new(wasm, Setup::minimal()) {
        Ok(i) => {
            let i = i.info;
            format!(
                "abi version: {}.{}\nupdate rate: {} Hz\nsize: {} x {}\nmemory: {} page(s) of 64 KiB\nimports:\n{}\n",
                i.abi_version >> 16,
                i.abi_version & 0xFFFF,
                i.update_hz,
                i.width,
                i.height,
                i.memory_pages,
                i.imports.iter().map(|s| format!("  {s}")).collect::<Vec<_>>().join("\n")
            )
        }
        Err(e) => format!("load error: {e}\n"),
    }
}
