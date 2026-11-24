//! Scenes: parsing, running (the stepping rules) and composition (the document's "Stepping and
//! composition" and "The conformance profile").

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::rc::Rc;

use serde::Deserialize;

use crate::abi::update_due;
use crate::frame::Frame;
use crate::host::{Asset, Assets, Instance, Setup};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PanelDef {
    width: usize,
    height: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetDef {
    name: String,
    file: String,
    width: usize,
    height: usize,
    frames: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlacementDef {
    module: String,
    x: i32,
    y: i32,
    width: usize,
    height: usize,
    z: i32,
    opacity: u32,
    config: Box<serde_json::value::RawValue>,
    seed: u32,
}

/// One placement of a scene.
#[derive(Debug)]
pub struct Placement {
    /// The module's name (`<name>.wasm` in the modules directory).
    pub module: String,
    /// Left edge on the panel.
    pub x: i32,
    /// Top edge on the panel.
    pub y: i32,
    /// Layer width.
    pub width: usize,
    /// Layer height.
    pub height: usize,
    /// Stacking order.
    pub z: i32,
    /// Layer opacity, 0 to 255.
    pub opacity: u32,
    /// The config's bytes: its canonical form (RFC 8785), what `config_read` copies.
    pub config: Vec<u8>,
    /// The xorshift32 seed.
    pub seed: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneFile {
    abi: String,
    panel: PanelDef,
    start_unix_ms: i64,
    utc_offset_s: i32,
    ticks: Vec<u64>,
    assets: Vec<AssetDef>,
    placements: Vec<PlacementDef>,
}

/// A parsed scene with its assets read.
#[derive(Debug)]
pub struct Scene {
    /// The scene's name (its file name without `.json`).
    pub name: String,
    /// Panel width.
    pub width: usize,
    /// Panel height.
    pub height: usize,
    /// The clock at tick 0, Unix milliseconds.
    pub start_unix_ms: i64,
    /// The timezone offset in seconds east of UTC.
    pub utc_offset_s: i32,
    /// The ticks to capture, ascending.
    pub ticks: Vec<u64>,
    /// The assets by name.
    pub assets: Rc<Assets>,
    /// The placements in scene order.
    pub placements: Vec<Placement>,
}

impl Scene {
    /// Reads a scene file; its assets are read from `../assets/` beside the scenes directory.
    ///
    /// # Errors
    /// A message naming the file and the problem (an unknown or missing field by its name).
    pub fn load(path: &Path) -> Result<Scene, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scene")
            .to_string();
        let assets_dir = path
            .parent()
            .map_or_else(|| "assets".into(), |p| p.join("../assets"));
        Scene::from_json(&name, &text, &assets_dir).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Parses a scene from its JSON text.
    ///
    /// # Errors
    /// A message naming the field at fault.
    pub fn from_json(name: &str, text: &str, assets_dir: &Path) -> Result<Scene, String> {
        let s: SceneFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if s.abi != "0.1" {
            return Err(format!(
                "abi: the scene is for ABI {}, this host runs 0.1",
                s.abi
            ));
        }
        if !(1..=16384).contains(&s.panel.width) || !(1..=16384).contains(&s.panel.height) {
            return Err("panel: width and height are 1 to 16384".into());
        }
        if s.ticks.is_empty() || s.ticks.windows(2).any(|w| w[0] >= w[1]) {
            return Err("ticks: a non-empty ascending list".into());
        }
        for (i, p) in s.placements.iter().enumerate() {
            if p.opacity > 255 {
                return Err(format!(
                    "placements[{i}].opacity: {} is not 0 to 255",
                    p.opacity
                ));
            }
            if p.seed == 0 {
                return Err(format!("placements[{i}].seed: must not be 0"));
            }
            if !(1..=4096).contains(&p.width) || !(1..=4096).contains(&p.height) {
                return Err(format!("placements[{i}]: width and height are 1 to 4096"));
            }
        }
        let mut placements = Vec::with_capacity(s.placements.len());
        for (i, p) in s.placements.into_iter().enumerate() {
            let config =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(p.config.get())
                    .map_err(|e| e.to_string())
                    .and_then(|m| crate::config::canonical(&m))
                    .map_err(|e| format!("placements[{i}].config: {e}"))?;
            placements.push(Placement {
                module: p.module,
                x: p.x,
                y: p.y,
                width: p.width,
                height: p.height,
                z: p.z,
                opacity: p.opacity,
                config,
                seed: p.seed,
            });
        }
        let mut assets = Assets::new();
        for a in &s.assets {
            let data = std::fs::read(assets_dir.join(&a.file))
                .map_err(|e| format!("assets: {}: {e}", a.file))?;
            if data.len() != a.width * a.height * a.frames * 3 {
                return Err(format!(
                    "assets: {} is {} bytes, width {} x height {} x frames {} x 3 is {}",
                    a.file,
                    data.len(),
                    a.width,
                    a.height,
                    a.frames,
                    a.width * a.height * a.frames * 3
                ));
            }
            assets.insert(
                a.name.clone(),
                Asset {
                    width: a.width,
                    height: a.height,
                    frames: a.frames,
                    data,
                },
            );
        }
        Ok(Scene {
            name: name.to_string(),
            width: s.panel.width,
            height: s.panel.height,
            start_unix_ms: s.start_unix_ms,
            utc_offset_s: s.utc_offset_s,
            ticks: s.ticks,
            assets: Rc::new(assets),
            placements,
        })
    }
}

/// A run ended in an error.
#[derive(Debug, Clone)]
pub struct RunError {
    /// The placement's index in the scene.
    pub placement: usize,
    /// Its module's name.
    pub module: String,
    /// The export that was being called, or `load`.
    pub export: String,
    /// The tick.
    pub tick: u64,
    /// What went wrong.
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "placement {} ({}): {} at tick {}: {}",
            self.placement, self.module, self.export, self.tick, self.message
        )
    }
}

impl std::error::Error for RunError {}

/// The frames captured before a run ended, and the error that ended it, if any.
#[derive(Debug)]
pub struct Run {
    /// The captured frames by tick; none for the tick of an error or later.
    pub frames: Vec<(u64, Frame)>,
    /// The error, naming placement, export and tick.
    pub error: Option<RunError>,
}

/// The clock of the conformance profile at `tick`.
#[must_use]
pub fn time_at(start_unix_ms: i64, tick: u64) -> i64 {
    start_unix_ms + i64::try_from(u128::from(tick) * 1000 / 60).unwrap_or(i64::MAX)
}

/// Composes layers (already in order) onto a black frame.
#[must_use]
pub fn compose(
    width: usize,
    height: usize,
    layers: &[(&crate::raster::Layer, i32, i32, u32)],
) -> Frame {
    let mut frame = Frame::black(width, height);
    for &(layer, ox, oy, opacity) in layers {
        for ly in 0..layer.height {
            let Some(py) = usize::try_from(i64::from(oy) + i64::try_from(ly).unwrap_or(i64::MAX))
                .ok()
                .filter(|y| *y < height)
            else {
                continue;
            };
            for lx in 0..layer.width {
                let Some(px) =
                    usize::try_from(i64::from(ox) + i64::try_from(lx).unwrap_or(i64::MAX))
                        .ok()
                        .filter(|x| *x < width)
                else {
                    continue;
                };
                let pixel = layer.pixels[ly * layer.width + lx];
                let alpha = ((pixel & 0xFF) * opacity + 127) / 255;
                let at = (py * width + px) * 3;
                for (channel, shift) in [24, 16, 8].into_iter().enumerate() {
                    let src = (pixel >> shift) & 0xFF;
                    let dst = u32::from(frame.rgb[at + channel]);
                    let out = (src * alpha + dst * (255 - alpha) + 127) / 255;
                    frame.rgb[at + channel] = u8::try_from(out).unwrap_or(255);
                }
            }
        }
    }
    frame
}

/// Runs a scene: loads each module with `load`, initialises, steps through the ticks and captures
/// the frames. `fuel` is the limit of one call to an export.
pub fn run(scene: &Scene, load: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>, fuel: u64) -> Run {
    let mut run = Run {
        frames: vec![],
        error: None,
    };
    let err = |placement: usize, export: &str, tick: u64, message: String| RunError {
        placement,
        module: scene.placements[placement].module.clone(),
        export: export.to_string(),
        tick,
        message,
    };
    let mut instances = vec![];
    for (i, p) in scene.placements.iter().enumerate() {
        let setup = Setup {
            width: p.width,
            height: p.height,
            config: p.config.clone(),
            seed: p.seed,
            assets: Rc::clone(&scene.assets),
            fuel,
        };
        let loaded = load(&p.module)
            .and_then(|bytes| Instance::new(&bytes, setup).map_err(|e| e.to_string()));
        match loaded {
            Ok(inst) => instances.push(inst),
            Err(m) => {
                run.error = Some(err(i, "load", 0, m));
                return run;
            }
        }
    }
    let mut order: Vec<usize> = (0..instances.len()).collect();
    order.sort_by_key(|&i| scene.placements[i].z);
    for (i, inst) in instances.iter_mut().enumerate() {
        if let Err(m) = inst.init(time_at(scene.start_unix_ms, 0), scene.utc_offset_s) {
            run.error = Some(err(i, "pn_init", 0, m));
            return run;
        }
    }
    let last = scene.ticks.last().copied().unwrap_or(0);
    for tick in 0..=last {
        for &i in &order {
            if update_due(instances[i].info.update_hz, tick)
                && let Err(m) = instances[i].update(
                    tick,
                    time_at(scene.start_unix_ms, tick),
                    scene.utc_offset_s,
                )
            {
                run.error = Some(err(i, "pn_update", tick, m));
                return run;
            }
        }
        if scene.ticks.binary_search(&tick).is_ok() {
            let layers: Vec<_> = order
                .iter()
                .map(|&i| {
                    let p = &scene.placements[i];
                    (instances[i].layer(), p.x, p.y, p.opacity)
                })
                .collect();
            run.frames
                .push((tick, compose(scene.width, scene.height, &layers)));
        }
    }
    run
}

/// `frames.json`: the scene's name, the panel size and the hash of each captured frame.
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Eq)]
pub struct FramesJson {
    /// The scene's name.
    pub scene: String,
    /// The panel's size.
    pub panel: BTreeMap<String, usize>,
    /// Per captured tick, the SHA-256 in hex of the frame's raw RGB bytes.
    pub frames: Vec<FrameHash>,
}

/// One entry of `frames.json`.
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameHash {
    /// The tick.
    pub tick: u64,
    /// The hash.
    pub sha256: String,
}

impl FramesJson {
    /// The `frames.json` of a run's frames.
    #[must_use]
    pub fn of(scene: &Scene, frames: &[(u64, Frame)]) -> FramesJson {
        FramesJson {
            scene: scene.name.clone(),
            panel: BTreeMap::from([
                ("height".to_string(), scene.height),
                ("width".to_string(), scene.width),
            ]),
            frames: frames
                .iter()
                .map(|(tick, f)| FrameHash {
                    tick: *tick,
                    sha256: f.sha256(),
                })
                .collect(),
        }
    }
}
