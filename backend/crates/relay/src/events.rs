//! The events on stdout (AC-14): one JSON object per line, flushed when written.

use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// The cumulative counters of a connection (frames and payload bytes of data frames only).
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Counts {
    /// Data frames sent.
    pub sent: u64,
    /// Content bytes sent.
    pub sent_bytes: u64,
    /// Ticks skipped.
    pub skipped: u64,
    /// Binary frames received.
    pub received: u64,
    /// Payload bytes received.
    pub received_bytes: u64,
    /// Frames received that were not well-formed CBOR.
    pub malformed: u64,
}

/// Why a connection ended.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// The peer sent a close frame.
    PeerClosed,
    /// The connection ended without a close frame.
    PeerLost,
    /// Nothing arrived for the idle timeout.
    Timeout,
    /// A binary frame larger than the maximum.
    TooBig,
    /// A text frame.
    TextFrame,
    /// The stub is stopping.
    Shutdown,
    /// A protocol violation or other failure.
    Error,
}

/// One event; the line also carries `event` and `ts`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// The socket is bound.
    Listening {
        /// The address bound.
        addr: SocketAddr,
        /// The endpoint path.
        path: &'static str,
        /// Frames per second.
        down_rate: u32,
        /// Content bytes per frame.
        down_size: usize,
        /// Largest uplink binary frame.
        max_up_size: usize,
        /// Most connections open at once.
        max_connections: usize,
    },
    /// A WebSocket was accepted.
    Connected {
        /// The connection number.
        conn: u64,
        /// The peer's address.
        peer: SocketAddr,
    },
    /// A client did not complete the TLS handshake.
    HandshakeFailed {
        /// The peer's address.
        peer: SocketAddr,
        /// A short text.
        error: String,
    },
    /// The counters of an open connection.
    Stats {
        /// The connection number.
        conn: u64,
        /// The counters.
        #[serde(flatten)]
        counts: Counts,
    },
    /// A connection ended.
    Disconnected {
        /// The connection number.
        conn: u64,
        /// Why.
        reason: Reason,
        /// The final counters.
        #[serde(flatten)]
        counts: Counts,
    },
}

#[derive(Serialize)]
struct Line<'a> {
    #[serde(flatten)]
    event: &'a Event,
    ts: u128,
}

/// Where events go: a writer shared between tasks.
#[derive(Clone)]
pub struct EventSink {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    failed: Arc<AtomicBool>,
}

impl EventSink {
    /// A sink writing lines to `out`.
    pub fn new(out: impl Write + Send + 'static) -> Self {
        Self {
            out: Arc::new(Mutex::new(Box::new(out))),
            failed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Writes one event as one line and flushes. A failed write is logged once and ignored.
    pub fn emit(&self, event: &Event) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let mut line = serde_json::to_vec(&Line { event, ts }).unwrap_or_default();
        line.push(b'\n');
        let mut out = self
            .out
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = out.write_all(&line).and_then(|()| out.flush());
        if let Err(e) = result
            && !self.failed.swap(true, Ordering::Relaxed)
        {
            tracing::error!("cannot write events: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn line(e: &Event) -> Value {
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::default());
        EventSink::new(buf.clone()).emit(e);
        let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text.matches('\n').count(), 1);
        assert!(text.ends_with('\n'));
        serde_json::from_str(&text).unwrap()
    }

    fn keys(v: &Value) -> Vec<&str> {
        let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        k.sort_unstable();
        k
    }

    const COUNT_KEYS: [&str; 6] = [
        "malformed",
        "received",
        "received_bytes",
        "sent",
        "sent_bytes",
        "skipped",
    ];

    #[test]
    fn each_event_has_exactly_its_fields() {
        let addr: SocketAddr = "127.0.0.1:8443".parse().unwrap();
        let v = line(&Event::Listening {
            addr,
            path: "/relay-stub",
            down_rate: 10,
            down_size: 256,
            max_up_size: 65536,
            max_connections: 4,
        });
        assert_eq!(
            keys(&v),
            [
                "addr",
                "down_rate",
                "down_size",
                "event",
                "max_connections",
                "max_up_size",
                "path",
                "ts"
            ]
        );
        assert_eq!(v["event"], "listening");
        assert_eq!(v["addr"], "127.0.0.1:8443");
        assert!(v["ts"].is_u64());

        let v = line(&Event::Connected {
            conn: 1,
            peer: addr,
        });
        assert_eq!(keys(&v), ["conn", "event", "peer", "ts"]);
        assert_eq!(v["conn"], json!(1));

        let v = line(&Event::HandshakeFailed {
            peer: addr,
            error: "bad".into(),
        });
        assert_eq!(keys(&v), ["error", "event", "peer", "ts"]);

        let v = line(&Event::Stats {
            conn: 2,
            counts: Counts::default(),
        });
        let mut want = vec!["conn", "event", "ts"];
        want.extend(COUNT_KEYS);
        want.sort_unstable();
        assert_eq!(keys(&v), want);

        let v = line(&Event::Disconnected {
            conn: 2,
            reason: Reason::Timeout,
            counts: Counts {
                sent: 3,
                ..Counts::default()
            },
        });
        want.push("reason");
        want.sort_unstable();
        assert_eq!(keys(&v), want);
        assert_eq!(v["sent"], json!(3));
    }

    #[test]
    fn every_reason_has_its_string() {
        for (r, s) in [
            (Reason::PeerClosed, "peer_closed"),
            (Reason::PeerLost, "peer_lost"),
            (Reason::Timeout, "timeout"),
            (Reason::TooBig, "too_big"),
            (Reason::TextFrame, "text_frame"),
            (Reason::Shutdown, "shutdown"),
            (Reason::Error, "error"),
        ] {
            let v = line(&Event::Disconnected {
                conn: 1,
                reason: r,
                counts: Counts::default(),
            });
            assert_eq!(v["reason"], s);
        }
    }
}
