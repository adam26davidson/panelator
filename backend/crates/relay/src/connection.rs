//! One WebSocket connection: downlink, uplink counting, liveness, and the reason it ended.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use bytes::Bytes;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, interval_at, sleep_until, timeout};

use crate::cbor::is_well_formed;
use crate::events::{Event, EventSink, Reason};
use crate::server::Timings;
use crate::traffic::{Counters, Slot, generate};

/// What a connection needs besides its socket.
pub struct Context {
    /// The connection's number.
    pub conn: u64,
    /// Where events go.
    pub events: EventSink,
    /// The peer's address.
    pub peer: std::net::SocketAddr,
    /// Frames per second down.
    pub down_rate: u32,
    /// The frame sent down, built once.
    pub frame: Bytes,
    /// The content length of the frame.
    pub down_size: u64,
    /// Largest binary frame accepted.
    pub max_up_size: usize,
    /// Seconds between stats.
    pub stats_interval: Duration,
    /// The timings.
    pub timings: Timings,
    /// True once the stub is stopping.
    pub shutdown: watch::Receiver<bool>,
}

enum Ctl {
    Ping,
    Close(u16),
}

fn close_message(code: u16) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: "".into(),
    }))
}

/// Whether a read error means the transport was lost rather than the protocol broken.
fn classify(e: &axum::Error) -> Reason {
    let text = e.to_string();
    if text.contains("Space limit") {
        Reason::TooBig
    } else if text.contains("IO error")
        || text.contains("without closing handshake")
        || text.contains("Connection closed")
    {
        Reason::PeerLost
    } else {
        Reason::Error
    }
}

fn spawn_writer(
    mut sink: SplitSink<WebSocket, Message>,
    mut ctl_rx: mpsc::Receiver<Ctl>,
    slot: Arc<Slot>,
    counters: Arc<Counters>,
    down_size: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                ctl = ctl_rx.recv() => match ctl {
                    Some(Ctl::Ping) => if sink.send(Message::Ping(Bytes::new())).await.is_err() { break },
                    Some(Ctl::Close(code)) => {
                        let _ = sink.send(close_message(code)).await;
                        break;
                    }
                    None => break,
                },
                f = slot.next_frame() => {
                    if sink.send(Message::Binary(f)).await.is_err() { break }
                    slot.written(&counters, down_size);
                }
            }
        }
    })
}

/// Runs the connection until one reason ends it, then emits `disconnected`.
pub async fn run(socket: WebSocket, ctx: Context) {
    let Context {
        conn,
        events,
        peer,
        down_rate,
        frame,
        down_size,
        max_up_size,
        stats_interval,
        timings,
        mut shutdown,
    } = ctx;
    events.emit(&Event::Connected { conn, peer });
    let counters = Arc::new(Counters::default());
    let slot = Arc::new(Slot::default());
    let (sink, mut stream) = socket.split();
    let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>(4);

    let writer = spawn_writer(sink, ctl_rx, slot.clone(), counters.clone(), down_size);
    let generator = tokio::spawn(generate(down_rate, frame, slot, counters.clone()));

    let mut ping = interval_at(
        Instant::now() + timings.ping_interval,
        timings.ping_interval,
    );
    let mut stats = interval_at(Instant::now() + stats_interval, stats_interval);
    let mut idle_deadline = Instant::now() + timings.idle_timeout;
    let mut close_code = None;
    let reason = loop {
        tokio::select! {
            msg = stream.next() => {
                idle_deadline = Instant::now() + timings.idle_timeout;
                match msg {
                    None => break Reason::PeerLost,
                    Some(Err(e)) => {
                        let reason = classify(&e);
                        if reason == Reason::TooBig { close_code = Some(1009); }
                        break reason;
                    }
                    Some(Ok(Message::Binary(b))) => {
                        if b.len() > max_up_size {
                            close_code = Some(1009);
                            break Reason::TooBig;
                        }
                        counters.received.fetch_add(1, Ordering::Relaxed);
                        counters.received_bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                        if !is_well_formed(&b) {
                            counters.malformed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Some(Ok(Message::Text(_))) => {
                        close_code = Some(1003);
                        break Reason::TextFrame;
                    }
                    Some(Ok(Message::Close(_))) => break Reason::PeerClosed,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                }
            }
            _ = ping.tick() => { let _ = ctl_tx.try_send(Ctl::Ping); }
            _ = stats.tick() => events.emit(&Event::Stats { conn, counts: counters.snapshot() }),
            () = sleep_until(idle_deadline) => break Reason::Timeout,
            _ = shutdown.wait_for(|stopping| *stopping) => {
                close_code = Some(1001);
                break Reason::Shutdown;
            }
        }
    };

    generator.abort();
    if let Some(code) = close_code {
        let _ = ctl_tx.try_send(Ctl::Close(code));
    }
    drop(ctl_tx);
    let mut writer = writer;
    if timeout(timings.close_grace, &mut writer).await.is_err() {
        writer.abort();
    }
    events.emit(&Event::Disconnected {
        conn,
        reason,
        counts: counters.snapshot(),
    });
}
