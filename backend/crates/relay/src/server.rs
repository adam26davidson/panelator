//! The TLS listener and the router: `GET /relay-stub` upgrades to a WebSocket.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Extension, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bytes::Bytes;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rustls::ServerConfig;
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;

use crate::cbor::filler_frame;
use crate::connection::{self, Context};
use crate::events::{Event, EventSink};

/// The path of the endpoint.
pub const PATH: &str = "/relay-stub";

/// Intervals that tests shorten; the command line cannot change them.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    /// Between pings the stub sends.
    pub ping_interval: Duration,
    /// Without any frame, after which a connection is closed.
    pub idle_timeout: Duration,
    /// For a client to finish the TLS handshake.
    pub handshake_timeout: Duration,
    /// For a close frame to be written before the writer is aborted.
    pub close_grace: Duration,
    /// In total for connections to end once the stub is told to stop.
    pub shutdown_deadline: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(10),
            close_grace: Duration::from_secs(1),
            shutdown_deadline: Duration::from_secs(3),
        }
    }
}

/// The configuration of `serve`, validated by the argument parser.
#[derive(Debug, Clone)]
pub struct Config {
    /// Where to listen.
    pub listen: SocketAddr,
    /// Frames per second down.
    pub down_rate: u32,
    /// Content bytes per frame down.
    pub down_size: usize,
    /// Largest binary frame accepted.
    pub max_up_size: usize,
    /// Most connections at once.
    pub max_connections: usize,
    /// Between stats events.
    pub stats_interval: Duration,
    /// Intervals.
    pub timings: Timings,
}

#[derive(Clone)]
struct State_ {
    cfg: Arc<Config>,
    events: EventSink,
    slots: Arc<Semaphore>,
    next_conn: Arc<AtomicU64>,
    frame: Bytes,
    shutdown: watch::Receiver<bool>,
}

#[derive(Clone, Copy)]
struct Peer(SocketAddr);

async fn upgrade(
    State(st): State<State_>,
    Extension(Peer(peer)): Extension<Peer>,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(permit) = st.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let conn = st.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    // The library's limits keep an oversized frame from being buffered; 125 is a control frame's.
    let limit = st.cfg.max_up_size.max(125);
    let ctx = Context {
        conn,
        events: st.events.clone(),
        peer,
        down_rate: st.cfg.down_rate,
        frame: st.frame.clone(),
        down_size: st.cfg.down_size as u64,
        max_up_size: st.cfg.max_up_size,
        stats_interval: st.cfg.stats_interval,
        timings: st.cfg.timings,
        shutdown: st.shutdown.clone(),
    };
    ws.max_frame_size(limit)
        .max_message_size(limit)
        .on_upgrade(move |socket| async move {
            connection::run(socket, ctx).await;
            drop(permit);
        })
}

/// A bound listener, ready to run.
pub struct Server {
    listener: TcpListener,
    tls: TlsAcceptor,
    cfg: Config,
}

impl Server {
    /// Binds `cfg.listen`.
    ///
    /// # Errors
    /// The bind failed.
    pub async fn bind(cfg: Config, tls: Arc<ServerConfig>) -> io::Result<Self> {
        let listener = TcpListener::bind(cfg.listen).await?;
        Ok(Self {
            listener,
            tls: TlsAcceptor::from(tls),
            cfg,
        })
    }

    /// The address actually bound.
    ///
    /// # Errors
    /// The socket has no address.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Serves until `stop` resolves, then closes every connection with status 1001.
    ///
    /// # Errors
    /// The listener was lost.
    pub async fn run(self, events: EventSink, stop: impl Future<Output = ()>) -> io::Result<()> {
        let addr = self.local_addr()?;
        let cfg = Arc::new(self.cfg);
        if !addr.ip().is_loopback() {
            tracing::warn!(
                "listening on {addr}, which is reachable from the network; the stub authenticates nobody"
            );
        }
        events.emit(&Event::Listening {
            addr,
            path: PATH,
            down_rate: cfg.down_rate,
            down_size: cfg.down_size,
            max_up_size: cfg.max_up_size,
            max_connections: cfg.max_connections,
        });
        let (stop_tx, stop_rx) = watch::channel(false);
        let slots = Arc::new(Semaphore::new(cfg.max_connections));
        let state = State_ {
            cfg: cfg.clone(),
            events: events.clone(),
            slots: slots.clone(),
            next_conn: Arc::new(AtomicU64::new(0)),
            frame: filler_frame(cfg.down_size),
            shutdown: stop_rx,
        };
        let app = Router::new().route(PATH, get(upgrade)).with_state(state);
        let mut tasks = JoinSet::new();
        tokio::pin!(stop);
        let mut result = Ok(());
        loop {
            tokio::select! {
                () = &mut stop => break,
                accepted = self.listener.accept() => match accepted {
                    Ok((tcp, peer)) => {
                        let (tls, app, events, hs) = (self.tls.clone(), app.clone(), events.clone(), cfg.timings.handshake_timeout);
                        tasks.spawn(async move {
                            let stream = match timeout(hs, tls.accept(tcp)).await {
                                Ok(Ok(s)) => s,
                                Ok(Err(e)) => return events.emit(&Event::HandshakeFailed { peer, error: short(&e.to_string()) }),
                                Err(_) => return events.emit(&Event::HandshakeFailed { peer, error: "handshake timed out".into() }),
                            };
                            let svc = service_fn(move |mut req: Request<Incoming>| {
                                req.extensions_mut().insert(Peer(peer));
                                app.clone().oneshot(req.map(Body::new))
                            });
                            let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).with_upgrades();
                            if let Err(e) = conn.await {
                                tracing::debug!("connection from {peer}: {e}");
                            }
                        });
                    }
                    Err(e) if is_transient(&e) => {
                        tracing::warn!("accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                },
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            }
        }
        // Stop accepting, close every open WebSocket, then drop what is left.
        drop(self.listener);
        let _ = stop_tx.send(true);
        let all = u32::try_from(cfg.max_connections).unwrap_or(64);
        let _ = timeout(cfg.timings.shutdown_deadline, slots.acquire_many(all)).await;
        tasks.abort_all();
        result
    }
}

fn short(s: &str) -> String {
    s.chars().take(120).collect()
}

fn is_transient(e: &io::Error) -> bool {
    !matches!(
        e.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::NotConnected | io::ErrorKind::AddrNotAvailable
    )
}
