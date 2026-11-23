//! The process: argument parsing, logging, signals and exit statuses.

use std::ffi::OsString;
use std::process::ExitCode;
use std::time::Duration;

use clap::Parser;
use tokio::signal::unix::{SignalKind, signal};

use crate::certs::{ConfigError, write_set};
use crate::cli::{Cli, Command, GenCertArgs, LogLevel, ServeArgs};
use crate::events::EventSink;
use crate::server::{Config, Server, Timings};
use crate::tls::load_config;

const USAGE: u8 = 2;

/// Runs the command line `args` (the first is the program name) and returns the exit status.
#[must_use]
pub fn main_with_args(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => {
            let _ = e.print();
            return ExitCode::from(u8::try_from(e.exit_code()).unwrap_or(USAGE));
        }
    };
    match cli.command {
        Command::GenCert(args) => gen_cert(&args),
        Command::Serve(args) => serve(&args),
    }
}

fn init_logging(level: LogLevel) {
    let level = match level {
        LogLevel::Trace => tracing::Level::TRACE,
        LogLevel::Debug => tracing::Level::DEBUG,
        LogLevel::Info => tracing::Level::INFO,
        LogLevel::Warn => tracing::Level::WARN,
        LogLevel::Error => tracing::Level::ERROR,
    };
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_max_level(level)
        .init();
}

fn gen_cert(args: &GenCertArgs) -> ExitCode {
    init_logging(LogLevel::Info);
    match write_set(&args.out, &args.san, args.days, args.force) {
        Ok(paths) => {
            for p in paths {
                tracing::info!("wrote {}", p.display());
            }
            ExitCode::SUCCESS
        }
        Err(e) => config_error(&e),
    }
}

fn config_error(e: &ConfigError) -> ExitCode {
    eprintln!("error: {e}");
    ExitCode::from(USAGE)
}

fn serve(args: &ServeArgs) -> ExitCode {
    init_logging(args.log_level);
    let tls = match load_config(&args.tls_cert, &args.tls_key) {
        Ok(t) => t,
        Err(e) => return config_error(&e),
    };
    let cfg = Config {
        listen: args.listen,
        down_rate: args.down_rate,
        down_size: args.down_size as usize,
        max_up_size: args.max_up_size as usize,
        max_connections: args.max_connections as usize,
        stats_interval: Duration::from_secs(u64::from(args.stats_interval)),
        timings: Timings::default(),
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(async {
        let server = match Server::bind(cfg, tls).await {
            Ok(s) => s,
            Err(e) => {
                return config_error(&ConfigError(format!(
                    "cannot listen on {}: {e}",
                    args.listen
                )));
            }
        };
        let (mut term, mut int) = match (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => {
                eprintln!("error: cannot install signal handlers: {e}");
                return ExitCode::FAILURE;
            }
        };
        let stop = async {
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
        };
        match server.run(EventSink::new(std::io::stdout()), stop).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                tracing::error!("the listener failed: {e}");
                ExitCode::FAILURE
            }
        }
    })
}
