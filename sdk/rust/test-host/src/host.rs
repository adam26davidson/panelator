//! Loading a module (the rules of the document's "Module form and limits" and "Exports") and
//! running its exports against a layer, with the host imports.

use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

use wasmi::{Caller, Config, Engine, Error, Extern, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, TypedFunc, ValType};

use crate::abi::{self, EXPORTS, IMPORTS, MAX_PAGES};
use crate::font::{self, Fonts};
use crate::raster::Layer;

/// A load failed: the rule that was broken and what broke it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError {
    /// The rule, for example `imports` or `feature simd`.
    pub rule: String,
    /// The offending import, export, feature or versions.
    pub detail: String,
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.rule, self.detail)
    }
}

impl std::error::Error for LoadError {}

fn bad(rule: &str, detail: impl Into<String>) -> LoadError {
    LoadError { rule: rule.to_string(), detail: detail.into() }
}

/// An image the host can blit.
#[derive(Debug, Clone)]
pub struct Asset {
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// Number of frames.
    pub frames: usize,
    /// Raw RGB, rows top to bottom, frames one after another.
    pub data: Vec<u8>,
}

/// The assets of a scene by name.
pub type Assets = HashMap<String, Asset>;

/// What a placement is given.
pub struct Setup {
    /// Layer width.
    pub width: usize,
    /// Layer height.
    pub height: usize,
    /// The config document (a JSON object).
    pub config: Vec<u8>,
    /// The xorshift32 seed (non-zero).
    pub seed: u32,
    /// The assets of the scene.
    pub assets: Rc<Assets>,
    /// The fuel each call may use.
    pub fuel: u64,
}

impl Setup {
    /// A 1 by 1 layer, config `{}`, no assets: enough to read a module's declarations.
    #[must_use]
    pub fn minimal() -> Setup {
        Setup { width: 1, height: 1, config: b"{}".to_vec(), seed: 1, assets: Rc::new(Assets::new()), fuel: DEFAULT_FUEL }
    }
}

/// The default fuel limit of one call to an export.
pub const DEFAULT_FUEL: u64 = 10_000_000;

/// The host state a module's imports work on.
pub struct State {
    /// The placement's layer.
    pub layer: Layer,
    config: Vec<u8>,
    assets: Rc<Assets>,
    fonts: Rc<Fonts>,
    time_ms: i64,
    offset_s: i32,
    rng: u32,
    limits: StoreLimits,
}

/// What `inspect` reports of a module.
#[derive(Debug, Clone)]
pub struct Info {
    /// `pn_abi_version`.
    pub abi_version: u32,
    /// `pn_update_hz`.
    pub update_hz: u32,
    /// `pn_width`.
    pub width: u32,
    /// `pn_height`.
    pub height: u32,
    /// The imports as `module.name`.
    pub imports: Vec<String>,
    /// The memory's declared initial size in pages.
    pub memory_pages: u64,
}

/// A loaded, instantiated module with its layer.
pub struct Instance {
    store: Store<State>,
    init: TypedFunc<(), ()>,
    update: TypedFunc<i64, ()>,
    /// The module's declarations and imports.
    pub info: Info,
    fuel: u64,
}

fn engine_config(strict: bool, without: Option<&str>) -> Config {
    let mut c = Config::default();
    c.consume_fuel(true);
    let off = |name: &str| strict || without == Some(name);
    c.allow_start_fn(!off("start function"));
    c.wasm_tail_call(!off("tail-call"));
    c.wasm_multi_memory(!off("multi-memory"));
    c.wasm_memory64(!off("memory64"));
    c.wasm_extended_const(!off("extended-const"));
    c.wasm_wide_arithmetic(!off("wide-arithmetic"));
    c.wasm_custom_page_sizes(!off("custom-page-sizes"));
    c
}

const FORBIDDEN: &[&str] =
    &["start function", "tail-call", "multi-memory", "memory64", "extended-const", "wide-arithmetic", "custom-page-sizes"];

fn compile(wasm: &[u8]) -> Result<(Engine, Module), LoadError> {
    if wasm.get(4..8) == Some(&[0x0d, 0x00, 0x01, 0x00]) {
        return Err(bad("module form", "a component, not a core module"));
    }
    // Find the first forbidden feature the module needs: it is valid with everything on and
    // invalid once that one is off.
    let all = Engine::new(&engine_config(false, None));
    if let Err(e) = Module::new(&all, wasm) {
        let text = e.to_string();
        if text.to_lowercase().contains("simd") || text.contains("v128") {
            return Err(bad("feature simd", format!("the module uses SIMD, which ABI 0.1 never allows: {text}")));
        }
        return Err(bad("module form", format!("not a valid core module with the supported features: {e}")));
    }
    for name in FORBIDDEN {
        let engine = Engine::new(&engine_config(false, Some(name)));
        if Module::new(&engine, wasm).is_err() {
            return Err(if *name == "start function" {
                bad("start function", "the module has a start function")
            } else {
                bad(&format!("feature {name}"), format!("the module uses {name}, which ABI 0.1 never allows"))
            });
        }
    }
    let engine = Engine::new(&engine_config(true, None));
    let module = Module::new(&engine, wasm).map_err(|e| bad("module form", e.to_string()))?;
    Ok((engine, module))
}

fn ty_name(t: &ValType) -> &'static str {
    match t {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        _ => "other",
    }
}

fn sig_of(params: &[ValType], results: &[ValType]) -> String {
    let p: Vec<_> = params.iter().map(ty_name).collect();
    let r = match results {
        [] => "()",
        [one] => ty_name(one),
        _ => "multi",
    };
    format!("({})->{r}", p.join(","))
}

fn check_shape(module: &Module) -> Result<(u64, Vec<String>), LoadError> {
    let mut imports = vec![];
    for imp in module.imports() {
        let id = format!("{}.{}", imp.module(), imp.name());
        let wasmi::ExternType::Func(ft) = imp.ty() else {
            return Err(bad("imports", format!("{id} is not a function; a module imports only functions of ABI 0.1")));
        };
        if imp.module() != "panelator" {
            return Err(bad("imports", format!("{id}: imports come from the module `panelator` only")));
        }
        let Some(def) = IMPORTS.iter().find(|d| d.name == imp.name()) else {
            return Err(bad("imports", format!("{id} is not an import of ABI 0.1")));
        };
        let got = sig_of(ft.params(), ft.results());
        if got != abi::signature(def) {
            return Err(bad("imports", format!("{id} has signature {got}, the ABI says {}", abi::signature(def))));
        }
        imports.push(id);
    }
    let mut memory_pages = None;
    let mut seen = vec![];
    for exp in module.exports() {
        let name = exp.name();
        match exp.ty() {
            wasmi::ExternType::Memory(mt) if name == "memory" => {
                if mt.minimum() > MAX_PAGES {
                    return Err(bad("memory", format!("the module declares {} pages, the limit is {MAX_PAGES}", mt.minimum())));
                }
                memory_pages = Some(mt.minimum());
            }
            wasmi::ExternType::Func(ft) => {
                let Some(def) = EXPORTS.iter().find(|d| d.name == name) else {
                    return Err(bad("exports", format!("{name} is not an export of ABI 0.1")));
                };
                let got = sig_of(ft.params(), ft.results());
                if got != abi::signature(def) {
                    return Err(bad("exports", format!("{name} has signature {got}, the ABI says {}", abi::signature(def))));
                }
                seen.push(def.name);
            }
            _ => return Err(bad("exports", format!("{name} is not an export of ABI 0.1"))),
        }
    }
    for def in EXPORTS {
        if !seen.contains(&def.name) {
            return Err(bad("exports", format!("the export {} is missing", def.name)));
        }
    }
    let pages = memory_pages.ok_or_else(|| bad("memory", "the module does not export its memory as `memory`"))?;
    Ok((pages, imports))
}

fn trap(msg: impl Into<String>) -> Error {
    Error::new(msg.into())
}

/// The bytes `[ptr, ptr + len)` of the module's memory, or a trap.
fn range(mem: &[u8], ptr: i32, len: i32, what: &str) -> Result<std::ops::Range<usize>, Error> {
    let (p, n) = (ptr.cast_unsigned() as usize, usize::try_from(len).ok());
    match n.and_then(|n| p.checked_add(n).map(|end| (p, end))) {
        Some((p, end)) if end <= mem.len() => Ok(p..end),
        _ => Err(trap(format!("{what}: pointer {ptr} length {len} is outside the module's memory of {} bytes", mem.len()))),
    }
}

/// Registers the 16 imports; returns the names registered.
///
/// # Errors
/// If the linker refuses a definition.
pub fn register(linker: &mut Linker<State>) -> Result<Vec<&'static str>, Error> {
    let mut names = vec![];
    macro_rules! reg {
        ($name:literal, $f:expr) => {{
            linker.func_wrap("panelator", $name, $f)?;
            names.push($name);
        }};
    }
    reg!("layer_width", |c: Caller<'_, State>| i32::try_from(c.data().layer.width).unwrap_or(i32::MAX));
    reg!("layer_height", |c: Caller<'_, State>| i32::try_from(c.data().layer.height).unwrap_or(i32::MAX));
    reg!("draw_fill", |mut c: Caller<'_, State>, color: i32| c.data_mut().layer.fill(color.cast_unsigned()));
    reg!("draw_pixel", |mut c: Caller<'_, State>, x: i32, y: i32, color: i32| c.data_mut().layer.pixel(x, y, color.cast_unsigned()));
    reg!("draw_line", |mut c: Caller<'_, State>, x0: i32, y0: i32, x1: i32, y1: i32, color: i32| {
        c.data_mut().layer.line(x0, y0, x1, y1, color.cast_unsigned());
    });
    reg!("draw_rect", |mut c: Caller<'_, State>, x: i32, y: i32, w: i32, h: i32, color: i32, filled: i32| {
        c.data_mut().layer.rect(x, y, w, h, color.cast_unsigned(), filled != 0);
    });
    reg!("draw_circle", |mut c: Caller<'_, State>, cx: i32, cy: i32, r: i32, color: i32, filled: i32| {
        c.data_mut().layer.circle(cx, cy, r, color.cast_unsigned(), filled != 0);
    });
    reg!("draw_text", |mut c: Caller<'_, State>, font_id: i32, x: i32, y: i32, ptr: i32, len: i32, color: i32| -> Result<i32, Error> {
        let (mem, st) = memory(&mut c)?;
        let r = range(mem, ptr, len, "draw_text")?;
        let fonts = Rc::clone(&st.fonts);
        let Some(font) = fonts.get(font_id) else { return Ok(-1) };
        let color = color.cast_unsigned();
        Ok(font::draw_text(font, x, y, &mem[r], |px, py| st.layer.set(px, py, color)))
    });
    reg!("text_width", |mut c: Caller<'_, State>, font_id: i32, ptr: i32, len: i32| -> Result<i32, Error> {
        let (mem, st) = memory(&mut c)?;
        let r = range(mem, ptr, len, "text_width")?;
        Ok(st.fonts.get(font_id).map_or(-1, |font| font::text_width(font, &mem[r])))
    });
    reg!("font_height", |c: Caller<'_, State>, font_id: i32| c.data().fonts.get(font_id).map_or(-1, |f| f.height));
    reg!("draw_image", |mut c: Caller<'_, State>, ptr: i32, len: i32, frame: i32, x: i32, y: i32| -> Result<i32, Error> {
        let (mem, st) = memory(&mut c)?;
        let r = range(mem, ptr, len, "draw_image")?;
        let assets = Rc::clone(&st.assets);
        let Some(asset) = std::str::from_utf8(&mem[r]).ok().and_then(|n| assets.get(n)) else { return Ok(-1) };
        let Some(frame) = usize::try_from(frame).ok().filter(|f| *f < asset.frames) else { return Ok(-2) };
        blit(&mut st.layer, asset, frame, x, y);
        Ok(0)
    });
    reg!("config_len", |c: Caller<'_, State>| i32::try_from(c.data().config.len()).unwrap_or(i32::MAX));
    reg!("config_read", |mut c: Caller<'_, State>, ptr: i32, cap: i32| -> Result<i32, Error> {
        let (mem, st) = memory(&mut c)?;
        let n = usize::try_from(cap).unwrap_or(0).min(st.config.len());
        let r = range(mem, ptr, i32::try_from(n).unwrap_or(0), "config_read")?;
        mem[r].copy_from_slice(&st.config[..n]);
        Ok(i32::try_from(n).unwrap_or(0))
    });
    reg!("time_unix_ms", |c: Caller<'_, State>| c.data().time_ms);
    reg!("time_utc_offset_s", |c: Caller<'_, State>| c.data().offset_s);
    reg!("random_u32", |mut c: Caller<'_, State>| {
        let st = c.data_mut();
        st.rng = abi::xorshift32(st.rng);
        st.rng.cast_signed()
    });
    Ok(names)
}

fn memory<'a>(c: &'a mut Caller<'_, State>) -> Result<(&'a mut [u8], &'a mut State), Error> {
    let m = c.get_export("memory").and_then(Extern::into_memory).ok_or_else(|| trap("the module has no memory"))?;
    Ok(m.data_and_store_mut(c))
}

fn blit(layer: &mut Layer, asset: &Asset, frame: usize, x: i32, y: i32) {
    let base = frame * asset.width * asset.height * 3;
    let (x, y) = (i64::from(x), i64::from(y));
    let (w, h) = (i64::try_from(asset.width).unwrap_or(0), i64::try_from(asset.height).unwrap_or(0));
    let (lw, lh) = (i64::try_from(layer.width).unwrap_or(0), i64::try_from(layer.height).unwrap_or(0));
    for j in (-y).max(0)..h.min(lh - y) {
        for i in (-x).max(0)..w.min(lw - x) {
            let o = base + (usize::try_from(j).unwrap_or(0) * asset.width + usize::try_from(i).unwrap_or(0)) * 3;
            let px = &asset.data[o..o + 3];
            layer.set(x + i, y + j, u32::from_be_bytes([px[0], px[1], px[2], 255]));
        }
    }
}

impl Instance {
    /// Loads and instantiates a module and reads its declarations.
    ///
    /// # Errors
    /// The rule of the ABI the module breaks, naming the offending import, export, feature or
    /// versions.
    pub fn new(wasm: &[u8], setup: Setup) -> Result<Instance, LoadError> {
        let (engine, module) = compile(wasm)?;
        let (memory_pages, imports) = check_shape(&module)?;
        let fonts = Rc::new(Fonts::builtin());
        let mut linker = Linker::<State>::new(&engine);
        register(&mut linker).map_err(|e| bad("imports", e.to_string()))?;
        let state = State {
            layer: Layer::new(setup.width, setup.height),
            config: setup.config,
            assets: setup.assets,
            fonts,
            time_ms: 0,
            offset_s: 0,
            rng: setup.seed,
            limits: StoreLimitsBuilder::new().memory_size(usize::try_from(MAX_PAGES * 65536).unwrap_or(0)).build(),
        };
        let mut store = Store::new(&engine, state);
        store.limiter(|s| &mut s.limits);
        store.set_fuel(setup.fuel).map_err(|e| bad("instantiate", e.to_string()))?;
        let instance = linker.instantiate_and_start(&mut store, &module).map_err(|e| bad("instantiate", e.to_string()))?;
        let mut declare = |name: &str| -> Result<i32, LoadError> {
            let f = instance.get_typed_func::<(), i32>(&store, name).map_err(|e| bad("exports", format!("{name}: {e}")))?;
            store.set_fuel(setup.fuel).map_err(|e| bad("instantiate", e.to_string()))?;
            f.call(&mut store, ()).map_err(|e| bad("declaration", format!("{name} failed: {e}")))
        };
        let version = declare("pn_abi_version")?.cast_unsigned();
        let (major, minor) = (version >> 16, version & 0xFFFF);
        if major != abi::MAJOR || minor > abi::MINOR {
            return Err(bad("abi version", format!("the module is built for ABI {major}.{minor}, this host is ABI {}.{}", abi::MAJOR, abi::MINOR)));
        }
        let hz = declare("pn_update_hz")?;
        if !(0..=60).contains(&hz) {
            return Err(bad("declaration", format!("pn_update_hz returned {hz}, expected 0 to 60")));
        }
        let width = declare("pn_width")?;
        let height = declare("pn_height")?;
        for (name, v) in [("pn_width", width), ("pn_height", height)] {
            if !(1..=4096).contains(&v) {
                return Err(bad("declaration", format!("{name} returned {v}, expected 1 to 4096")));
            }
        }
        let init = instance.get_typed_func::<(), ()>(&store, "pn_init").map_err(|e| bad("exports", e.to_string()))?;
        let update = instance.get_typed_func::<i64, ()>(&store, "pn_update").map_err(|e| bad("exports", e.to_string()))?;
        Ok(Instance {
            store,
            init,
            update,
            info: Info {
                abi_version: version,
                update_hz: hz.cast_unsigned(),
                width: width.cast_unsigned(),
                height: height.cast_unsigned(),
                imports,
                memory_pages,
            },
            fuel: setup.fuel,
        })
    }

    /// The placement's layer.
    #[must_use]
    pub fn layer(&self) -> &Layer {
        &self.store.data().layer
    }

    fn call<P: wasmi::WasmParams>(&mut self, f: &TypedFunc<P, ()>, p: P, time_ms: i64, offset_s: i32) -> Result<(), String> {
        let st = self.store.data_mut();
        st.time_ms = time_ms;
        st.offset_s = offset_s;
        self.store.set_fuel(self.fuel).map_err(|e| e.to_string())?;
        f.call(&mut self.store, p).map_err(|e| e.to_string())
    }

    /// Calls `pn_init` with the clock fixed at `time_ms`.
    ///
    /// # Errors
    /// The trap or fuel overrun, as text.
    pub fn init(&mut self, time_ms: i64, offset_s: i32) -> Result<(), String> {
        let f = self.init;
        self.call(&f, (), time_ms, offset_s)
    }

    /// Calls `pn_update(tick)` with the clock fixed at `time_ms`.
    ///
    /// # Errors
    /// The trap or fuel overrun, as text.
    pub fn update(&mut self, tick: u64, time_ms: i64, offset_s: i32) -> Result<(), String> {
        let f = self.update;
        self.call(&f, tick.cast_signed(), time_ms, offset_s)
    }
}
