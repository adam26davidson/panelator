//! The built binary: exit statuses, stdout events, signals, environment variables (AC-5, AC-12 to AC-14, AC-16).

mod common;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use common::ws_connect;
use futures_util::StreamExt;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

const BIN: &str = env!("CARGO_BIN_EXE_panelator-relay-stub");

fn run(args: &[&str], envs: &[(&str, &str)]) -> std::process::Output {
    let child = Command::new(BIN)
        .args(args)
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.wait_with_output().unwrap()
}

fn gen_certs(dir: &Path) {
    let out = run(
        &[
            "gen-cert",
            "--out",
            dir.to_str().unwrap(),
            "--san",
            "localhost",
            "--san",
            "127.0.0.1",
        ],
        &[],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Stub {
    child: Child,
    lines: mpsc::Receiver<String>,
    seen: Vec<String>,
}

impl Stub {
    fn start(dir: &Path, extra: &[&str], envs: &[(&str, &str)]) -> Self {
        let mut child = Command::new(BIN)
            .args(["serve", "--listen", "127.0.0.1:0", "--tls-cert"])
            .arg(dir.join("server.pem"))
            .arg("--tls-key")
            .arg(dir.join("server.key"))
            .args(extra)
            .envs(envs.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let out = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            lines,
            seen: Vec::new(),
        }
    }

    fn line(&mut self) -> Value {
        let l = self
            .lines
            .recv_timeout(Duration::from_secs(20))
            .expect("a line on stdout");
        self.seen.push(l.clone());
        serde_json::from_str(&l).expect("stdout holds only JSON events")
    }

    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .arg(format!("-{name}"))
            .arg(self.child.id().to_string())
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn wait_exit(&mut self, within: Duration) -> Option<i32> {
        let start = Instant::now();
        while start.elapsed() < within {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn addr_of(listening: &Value) -> std::net::SocketAddr {
    listening["addr"].as_str().unwrap().parse().unwrap()
}

async fn stops_on(signal: &str) {
    let dir = tempfile::tempdir().unwrap();
    gen_certs(dir.path());
    let mut stub = Stub::start(dir.path(), &[], &[]);
    let listening = stub.line();
    assert_eq!(listening["event"], "listening");
    let addr = addr_of(&listening);
    assert_ne!(addr.port(), 0);
    let mut ws = ws_connect(addr, "localhost", &dir.path().join("ca.pem"))
        .await
        .unwrap();
    assert_eq!(stub.line()["event"], "connected");
    stub.signal(signal);
    let code = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(Some(f)))) => return u16::from(f.code),
                Some(Ok(_)) => {}
                other => panic!("{other:?}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(code, 1001);
    assert_eq!(stub.wait_exit(Duration::from_secs(5)), Some(0));
    let mut last = None;
    while let Ok(l) = stub.lines.try_recv() {
        last = Some(l);
    }
    let last: Value = serde_json::from_str(&last.expect("a final line")).unwrap();
    assert_eq!(last["event"], "disconnected");
    assert_eq!(last["reason"], "shutdown");
}

#[tokio::test]
async fn sigterm_closes_connections_and_exits_zero() {
    stops_on("TERM").await;
}

#[tokio::test]
async fn sigint_closes_connections_and_exits_zero() {
    stops_on("INT").await;
}

#[test]
fn every_stdout_line_is_an_event_and_secrets_stay_out_of_the_streams() {
    let dir = tempfile::tempdir().unwrap();
    gen_certs(dir.path());
    let key = std::fs::read_to_string(dir.path().join("server.key")).unwrap();
    let body: String = key.lines().filter(|l| !l.starts_with("-----")).collect();
    let mut child = Command::new(BIN)
        .args([
            "serve",
            "--listen",
            "0.0.0.0:0",
            "--log-level",
            "debug",
            "--tls-cert",
        ])
        .arg(dir.path().join("server.pem"))
        .arg("--tls-key")
        .arg(dir.path().join("server.key"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    out.read_line(&mut first).unwrap();
    let v: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(v["event"], "listening");
    assert!(v["ts"].is_u64());
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        stderr.matches("authenticates nobody").count(),
        1,
        "{stderr}"
    );
    assert!(!stderr.contains(&body) && !first.contains(&body));
}

#[test]
fn configuration_errors_exit_2_without_listening() {
    let dir = tempfile::tempdir().unwrap();
    gen_certs(dir.path());
    let cert = dir.path().join("server.pem");
    let missing = dir.path().join("missing.key");
    let out = run(
        &[
            "serve",
            "--tls-cert",
            cert.to_str().unwrap(),
            "--tls-key",
            missing.to_str().unwrap(),
        ],
        &[],
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("missing.key"));

    // A second gen-cert without --force changes nothing.
    let before = std::fs::read(dir.path().join("server.key")).unwrap();
    let out = run(
        &[
            "gen-cert",
            "--out",
            dir.path().to_str().unwrap(),
            "--san",
            "x.test",
        ],
        &[],
    );
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        std::fs::read(dir.path().join("server.key")).unwrap(),
        before
    );
}

#[test]
fn options_come_from_the_environment_and_the_command_line_wins() {
    let dir = tempfile::tempdir().unwrap();
    gen_certs(dir.path());
    let mut stub = Stub::start(dir.path(), &[], &[("PANELATOR_STUB_DOWN_RATE", "7")]);
    assert_eq!(stub.line()["down_rate"], 7);
    let mut stub = Stub::start(
        dir.path(),
        &["--down-rate", "9"],
        &[("PANELATOR_STUB_DOWN_RATE", "7")],
    );
    assert_eq!(stub.line()["down_rate"], 9);
}

type Case<'a> = (Vec<&'a str>, Vec<(&'a str, &'a str)>, &'a str);

#[test]
fn invalid_options_name_the_option_and_exit_2() {
    let dir = tempfile::tempdir().unwrap();
    gen_certs(dir.path());
    let (c, k) = (dir.path().join("server.pem"), dir.path().join("server.key"));
    let (c, k) = (c.to_str().unwrap(), k.to_str().unwrap());
    let cases: Vec<Case> = vec![
        (
            vec!["serve", "--tls-cert", c, "--tls-key", k],
            vec![("PANELATOR_STUB_DOWN_RATE", "1001")],
            "down-rate",
        ),
        (
            vec![
                "serve",
                "--tls-cert",
                c,
                "--tls-key",
                k,
                "--down-size",
                "1048577",
            ],
            vec![],
            "--down-size",
        ),
        (
            vec!["serve", "--tls-cert", c, "--tls-key", k, "--bogus"],
            vec![],
            "--bogus",
        ),
        (vec!["serve", "--tls-key", k], vec![], "--tls-cert"),
    ];
    for (args, envs, named) in cases {
        let out = run(&args, &envs);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(named),
            "{args:?}"
        );
    }
}
