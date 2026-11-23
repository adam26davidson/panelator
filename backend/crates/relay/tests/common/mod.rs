//! Shared helpers: certificates from the `gen-cert` code, an in-process server and a client that
//! trusts only the generated CA.
#![allow(dead_code, reason = "each test file uses some of the helpers")]

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use panelator_relay::certs::write_set;
use panelator_relay::events::EventSink;
use panelator_relay::server::Server;
pub use panelator_relay::server::{Config, Timings};
use panelator_relay::tls::load_config;
use rustls::ClientConfig;
use rustls::crypto::ring;
use rustls::{RootCertStore, pki_types::ServerName};
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub type Ws = WebSocketStream<TlsStream<TcpStream>>;

/// A writer that sends each event line to a channel.
struct ChannelWriter(mpsc::UnboundedSender<String>);

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        for line in String::from_utf8_lossy(buf).lines() {
            let _ = self.0.send(line.to_owned());
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn client_config(ca: &Path) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_file(ca).unwrap())
        .unwrap();
    let mut cfg = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(cfg)
}

pub async fn tls_connect(
    addr: SocketAddr,
    name: &str,
    ca: &Path,
) -> io::Result<TlsStream<TcpStream>> {
    let tcp = TcpStream::connect(addr).await?;
    let server_name = ServerName::try_from(name.to_owned()).unwrap();
    TlsConnector::from(client_config(ca))
        .connect(server_name, tcp)
        .await
}

pub async fn ws_connect(
    addr: SocketAddr,
    name: &str,
    ca: &Path,
) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let tls = tls_connect(addr, name, ca)
        .await
        .map_err(tokio_tungstenite::tungstenite::Error::Io)?;
    let url = format!("wss://{name}:{}/relay-stub", addr.port());
    let (ws, _) = tokio_tungstenite::client_async(url.into_client_request().unwrap(), tls).await?;
    Ok(ws)
}

pub struct Rig {
    pub dir: tempfile::TempDir,
    pub addr: SocketAddr,
    pub events: mpsc::UnboundedReceiver<Value>,
    stop: Option<oneshot::Sender<()>>,
    pub task: Option<JoinHandle<io::Result<()>>>,
}

impl Rig {
    pub fn ca(&self) -> PathBuf {
        self.dir.path().join("ca.pem")
    }

    pub async fn connect(&self) -> Ws {
        ws_connect(self.addr, "localhost", &self.ca())
            .await
            .unwrap()
    }

    pub fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }

    /// The next event satisfying `pred`, skipping others, within 20 seconds.
    pub async fn event_where(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        timeout(Duration::from_secs(20), async {
            loop {
                let v = self.events.recv().await.expect("events ended");
                if pred(&v) {
                    return v;
                }
            }
        })
        .await
        .expect("event did not arrive")
    }

    pub async fn event(&mut self, name: &str) -> Value {
        self.event_where(|v| v["event"] == name).await
    }
}

pub fn fast_timings() -> Timings {
    Timings {
        ping_interval: Duration::from_millis(100),
        idle_timeout: Duration::from_millis(600),
        handshake_timeout: Duration::from_secs(2),
        close_grace: Duration::from_millis(200),
        shutdown_deadline: Duration::from_secs(2),
    }
}

pub fn base_config() -> Config {
    Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        down_rate: 20,
        down_size: 64,
        max_up_size: 65536,
        max_connections: 4,
        stats_interval: Duration::from_millis(200),
        timings: Timings::default(),
    }
}

pub async fn start(cfg: Config) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    write_set(
        dir.path(),
        &["localhost".into(), "127.0.0.1".into()],
        1,
        false,
    )
    .unwrap();
    let tls = load_config(
        &dir.path().join("server.pem"),
        &dir.path().join("server.key"),
    )
    .unwrap();
    let server = Server::bind(cfg, tls).await.unwrap();
    let addr = server.local_addr().unwrap();
    let (tx, events) = mpsc::unbounded_channel::<String>();
    let (jtx, jrx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut rx = events;
        while let Some(line) = rx.recv().await {
            let _ = jtx.send(serde_json::from_str::<Value>(&line).expect("an event line is JSON"));
        }
    });
    let (stop, stop_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(server.run(EventSink::new(ChannelWriter(tx)), async {
        let _ = stop_rx.await;
    }));
    Rig {
        dir,
        addr,
        events: jrx,
        stop: Some(stop),
        task: Some(task),
    }
}
