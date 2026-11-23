//! The command line (spec 111 section 4). Ranges are enforced by the parser, so clap names the
//! option and exits with status 2.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum, value_parser};

/// The relay stub: test equipment for the runtime spike, not a deployed service.
#[derive(Debug, Parser)]
#[command(name = "panelator-relay-stub", version)]
pub struct Cli {
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Serve the WebSocket endpoint over TLS until SIGTERM or SIGINT.
    Serve(ServeArgs),
    /// Write a CA certificate and a server certificate with its key for a rig.
    GenCert(GenCertArgs),
}

/// The log level of stderr.
#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum LogLevel {
    /// Everything.
    Trace,
    /// Debugging.
    Debug,
    /// The default.
    Info,
    /// Warnings and errors.
    Warn,
    /// Errors only.
    Error,
}

/// Options of `serve`. Each is also read from `PANELATOR_STUB_<OPTION>`; the command line wins.
#[derive(Debug, Args)]
pub struct ServeArgs {
    /// PEM file: the server certificate, followed by its chain if it has one.
    #[arg(
        long,
        value_name = "FILE",
        env = "PANELATOR_STUB_TLS_CERT",
        hide_env_values = true
    )]
    pub tls_cert: PathBuf,
    /// PEM file: the server's private key.
    #[arg(
        long,
        value_name = "FILE",
        env = "PANELATOR_STUB_TLS_KEY",
        hide_env_values = true
    )]
    pub tls_key: PathBuf,
    /// Address to listen on; port 0 takes a free port. Default 127.0.0.1:8443.
    #[arg(
        long,
        value_name = "ADDR:PORT",
        default_value = "127.0.0.1:8443",
        env = "PANELATOR_STUB_LISTEN",
        hide_env_values = true
    )]
    pub listen: SocketAddr,
    /// Messages per second sent to each board, 0 to 1000. Default 10.
    #[arg(long, value_name = "N", default_value_t = 10, value_parser = value_parser!(u32).range(0..=1000), env = "PANELATOR_STUB_DOWN_RATE", hide_env_values = true)]
    pub down_rate: u32,
    /// Content bytes of each message sent, 0 to 1048576. Default 256.
    #[arg(long, value_name = "BYTES", default_value_t = 256, value_parser = value_parser!(u32).range(0..=1_048_576), env = "PANELATOR_STUB_DOWN_SIZE", hide_env_values = true)]
    pub down_size: u32,
    /// Largest binary frame accepted, 1 to 1048576 bytes. Default 65536.
    #[arg(long, value_name = "BYTES", default_value_t = 65536, value_parser = value_parser!(u32).range(1..=1_048_576), env = "PANELATOR_STUB_MAX_UP_SIZE", hide_env_values = true)]
    pub max_up_size: u32,
    /// Most connections open at once, 1 to 64. Default 4.
    #[arg(long, value_name = "N", default_value_t = 4, value_parser = value_parser!(u32).range(1..=64), env = "PANELATOR_STUB_MAX_CONNECTIONS", hide_env_values = true)]
    pub max_connections: u32,
    /// Seconds between `stats` events, 1 to 3600. Default 1.
    #[arg(long, value_name = "SECONDS", default_value_t = 1, value_parser = value_parser!(u32).range(1..=3600), env = "PANELATOR_STUB_STATS_INTERVAL", hide_env_values = true)]
    pub stats_interval: u32,
    /// Level of the logs on stderr: trace, debug, info, warn or error. Default info.
    #[arg(
        long,
        value_enum,
        default_value = "info",
        env = "PANELATOR_STUB_LOG_LEVEL",
        hide_env_values = true
    )]
    pub log_level: LogLevel,
}

/// Options of `gen-cert`. It reads no environment variables.
#[derive(Debug, Args)]
pub struct GenCertArgs {
    /// Directory for ca.pem, server.pem and server.key; created if needed.
    #[arg(long, value_name = "DIR")]
    pub out: PathBuf,
    /// A DNS name or IP address of the server certificate; one or more times.
    #[arg(long, value_name = "NAME-OR-IP", required = true)]
    pub san: Vec<String>,
    /// Days the certificates are valid, 1 to 825. Default 30.
    #[arg(long, value_name = "N", default_value_t = 30, value_parser = value_parser!(u32).range(1..=825))]
    pub days: u32,
    /// Overwrite existing files.
    #[arg(long)]
    pub force: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("panelator-relay-stub").chain(args.iter().copied()))
    }

    fn serve(extra: &[&str]) -> Result<ServeArgs, clap::Error> {
        let mut a = vec!["serve", "--tls-cert", "c.pem", "--tls-key", "k.pem"];
        a.extend_from_slice(extra);
        match parse(&a)?.command {
            Command::Serve(s) => Ok(s),
            Command::GenCert(_) => unreachable!(),
        }
    }

    #[test]
    fn defaults() {
        let s = serve(&[]).unwrap();
        assert_eq!(s.listen, "127.0.0.1:8443".parse().unwrap());
        assert_eq!((s.down_rate, s.down_size, s.max_up_size), (10, 256, 65536));
        assert_eq!(
            (s.max_connections, s.stats_interval, s.log_level),
            (4, 1, LogLevel::Info)
        );
    }

    #[test]
    fn each_bound_is_accepted_and_one_outside_is_rejected() {
        for (opt, lo, hi) in [
            ("--down-rate", 0u32, 1000u32),
            ("--down-size", 0, 1_048_576),
            ("--max-up-size", 1, 1_048_576),
            ("--max-connections", 1, 64),
            ("--stats-interval", 1, 3600),
        ] {
            for ok in [lo, hi] {
                serve(&[opt, &ok.to_string()]).unwrap();
            }
            for bad in [lo.checked_sub(1), Some(hi + 1)].into_iter().flatten() {
                let e = serve(&[opt, &bad.to_string()]).unwrap_err();
                assert!(e.to_string().contains(opt), "{opt}: {e}");
                assert_eq!(e.exit_code(), 2);
            }
        }
        let gen_args =
            |days: &str| parse(&["gen-cert", "--out", "d", "--san", "x", "--days", days]);
        gen_args("1").unwrap();
        gen_args("825").unwrap();
        for bad in ["0", "826"] {
            assert!(gen_args(bad).unwrap_err().to_string().contains("--days"));
        }
    }

    #[test]
    fn unknown_and_missing_options_are_named() {
        assert!(
            serve(&["--bogus"])
                .unwrap_err()
                .to_string()
                .contains("--bogus")
        );
        let e = parse(&["serve", "--tls-key", "k"]).unwrap_err().to_string();
        assert!(e.contains("--tls-cert"), "{e}");
        let e = parse(&["gen-cert", "--out", "d"]).unwrap_err().to_string();
        assert!(e.contains("--san"), "{e}");
        assert!(serve(&["--log-level", "loud"]).is_err());
    }

    #[test]
    fn help_names_every_option_range_default_and_variable() {
        let mut cmd = Cli::command();
        let help = cmd
            .find_subcommand_mut("serve")
            .unwrap()
            .render_long_help()
            .to_string();
        for want in [
            "--tls-cert",
            "--tls-key",
            "--listen",
            "--down-rate",
            "--down-size",
            "--max-up-size",
            "--max-connections",
            "--stats-interval",
            "--log-level",
            "0 to 1000",
            "0 to 1048576",
            "1 to 1048576",
            "1 to 64",
            "1 to 3600",
            "Default 10",
            "Default 256",
            "Default 65536",
            "Default 4",
            "1 to 3600. Default 1",
            "Default info",
            "127.0.0.1:8443",
            "PANELATOR_STUB_DOWN_RATE",
            "PANELATOR_STUB_TLS_CERT",
            "PANELATOR_STUB_LOG_LEVEL",
        ] {
            assert!(help.contains(want), "{want} missing from:\n{help}");
        }
        let help = cmd
            .find_subcommand_mut("gen-cert")
            .unwrap()
            .render_long_help()
            .to_string();
        for want in [
            "--out",
            "--san",
            "--days",
            "--force",
            "1 to 825",
            "Default 30",
        ] {
            assert!(help.contains(want), "{want} missing from:\n{help}");
        }
    }
}
