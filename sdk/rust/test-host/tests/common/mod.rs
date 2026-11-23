//! Small modules written in WAT for the host's tests.
#![allow(dead_code, reason = "each test file uses some of these")]

use panelator_test_host::host::{Instance, LoadError, Setup};

pub struct Wat {
    pub version: i32,
    pub hz: i32,
    pub width: i32,
    pub height: i32,
    pub imports: String,
    pub memory: String,
    pub data: String,
    pub init: String,
    pub update: String,
    pub extra: String,
}

impl Default for Wat {
    fn default() -> Wat {
        Wat {
            version: 1,
            hz: 1,
            width: 64,
            height: 32,
            imports: String::new(),
            memory: "(memory (export \"memory\") 1)".into(),
            data: String::new(),
            init: String::new(),
            update: String::new(),
            extra: String::new(),
        }
    }
}

impl Wat {
    pub fn text(&self) -> String {
        format!(
            r#"(module
  {imports}
  {memory}
  {data}
  (func (export "pn_abi_version") (result i32) (i32.const {version}))
  (func (export "pn_update_hz") (result i32) (i32.const {hz}))
  (func (export "pn_width") (result i32) (i32.const {width}))
  (func (export "pn_height") (result i32) (i32.const {height}))
  (func (export "pn_init") {init})
  (func (export "pn_update") (param i64) {update})
  {extra}
)"#,
            imports = self.imports,
            memory = self.memory,
            data = self.data,
            version = self.version,
            hz = self.hz,
            width = self.width,
            height = self.height,
            init = self.init,
            update = self.update,
            extra = self.extra,
        )
    }

    pub fn bytes(&self) -> Vec<u8> {
        wat::parse_str(self.text()).expect("valid WAT")
    }

    pub fn load(&self) -> Result<Instance, LoadError> {
        Instance::new(&self.bytes(), Setup::minimal())
    }
}

pub const DRAW_PIXEL: &str = r#"(import "panelator" "draw_pixel" (func $draw_pixel (param i32 i32 i32)))"#;

pub fn err(w: &Wat) -> String {
    match w.load() {
        Err(e) => e.to_string(),
        Ok(_) => panic!("the module loaded"),
    }
}
