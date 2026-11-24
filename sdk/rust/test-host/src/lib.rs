//! The reference host of widget ABI 0.1 (`docs/widget-abi.md`): it loads a module, steps it
//! against the retained-layer model, composes frames and compares them with golden frames.

pub mod abi;
pub mod config;
pub mod conformance;
pub mod font;
pub mod frame;
pub mod host;
pub mod raster;
pub mod scene;
pub mod tool;
