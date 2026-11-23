//! The relay stub binary: parses arguments and calls the library.

use std::process::ExitCode;

fn main() -> ExitCode {
    panelator_relay::app::main_with_args(std::env::args_os())
}
