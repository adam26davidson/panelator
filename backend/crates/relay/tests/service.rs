//! The service on real loopback sockets (AC-5 to AC-11, AC-13, AC-14, AC-15).

mod common;

use std::time::{Duration, Instant};

use common::{Ws, base_config, fast_timings, start, tls_connect, ws_connect};
use futures_util::{SinkExt, StreamExt};
use panelator_relay::cbor::is_well_formed;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// The next data (binary) frame, answering pings along the way.
async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    timeout(Duration::from_secs(20), async {
        loop {
            match ws.next().await.expect("closed").expect("error") {
                Message::Binary(b) => return b.to_vec(),
                Message::Close(_) => panic!("closed"),
                _ => {}
            }
        }
    })
    .await
    .expect("no frame")
}

async fn close_code(ws: &mut Ws) -> u16 {
    timeout(Duration::from_secs(20), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(Some(f)))) => return u16::from(f.code),
                Some(Ok(_)) => {}
                other => panic!("no close frame: {other:?}"),
            }
        }
    })
    .await
    .expect("no close")
}

#[tokio::test]
async fn tls_clients_that_trust_the_ca_connect_and_others_are_refused() {
    let mut rig = start(base_config()).await;
    let first = rig.event("listening").await;
    assert_eq!(first["addr"], rig.addr.to_string());
    assert_eq!(first["path"], "/relay-stub");
    assert_eq!(first["down_rate"], 20);

    let tls = tls_connect(rig.addr, "localhost", &rig.ca()).await.unwrap();
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    drop(tls);

    // A client trusting another CA is refused.
    let other = tempfile::tempdir().unwrap();
    panelator_relay::certs::write_set(other.path(), &["localhost".into()], 1, false).unwrap();
    assert!(
        tls_connect(rig.addr, "localhost", &other.path().join("ca.pem"))
            .await
            .is_err()
    );
    rig.event("handshake_failed").await;

    // Plain HTTP gets nothing.
    let mut tcp = tokio::net::TcpStream::connect(rig.addr).await.unwrap();
    tcp.write_all(b"GET /relay-stub HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ = timeout(Duration::from_secs(5), tcp.read_to_end(&mut buf)).await;
    assert!(!String::from_utf8_lossy(&buf).contains("HTTP/1.1 2"));
    rig.event("handshake_failed").await;

    // And the stub still serves.
    let _ws = rig.connect().await;
    rig.event("connected").await;
}

#[tokio::test]
async fn the_certificate_is_valid_for_its_sans_only() {
    let rig = start(base_config()).await;
    ws_connect(rig.addr, "localhost", &rig.ca()).await.unwrap();
    ws_connect(rig.addr, "127.0.0.1", &rig.ca()).await.unwrap();
    assert!(
        ws_connect(rig.addr, "other.example", &rig.ca())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_endpoint_upgrades_without_subprotocol_or_extension() {
    let mut rig = start(base_config()).await;
    let mut tls = tls_connect(rig.addr, "localhost", &rig.ca()).await.unwrap();
    let req = "GET /relay-stub HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
               Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
               Sec-WebSocket-Protocol: chat\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n";
    tls.write_all(req.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 2048];
    let n = timeout(Duration::from_secs(5), tls.read(&mut buf))
        .await
        .unwrap()
        .unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).to_lowercase();
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(
        !head.contains("sec-websocket-protocol") && !head.contains("sec-websocket-extensions"),
        "{head}"
    );
    let c = rig.event("connected").await;
    assert_eq!(c["conn"], 1);
    assert!(c["peer"].as_str().unwrap().starts_with("127.0.0.1:"));
}

async fn plain_get(rig: &common::Rig, path: &str) -> String {
    let mut tls = tls_connect(rig.addr, "localhost", &rig.ca()).await.unwrap();
    tls.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = Vec::new();
    let _ = timeout(Duration::from_secs(5), tls.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn a_request_without_upgrade_is_4xx_and_other_paths_404() {
    let rig = start(base_config()).await;
    let line = plain_get(&rig, "/relay-stub").await;
    assert!(line.starts_with("HTTP/1.1 4"), "{line}");
    assert!(plain_get(&rig, "/other").await.starts_with("HTTP/1.1 404"));
}

#[tokio::test]
async fn connections_are_bounded_numbered_and_independent() {
    let mut rig = start(common::Config {
        max_connections: 2,
        down_rate: 0,
        ..base_config()
    })
    .await;
    let a = rig.connect().await;
    let b = rig.connect().await;
    let third = ws_connect(rig.addr, "localhost", &rig.ca()).await;
    match third {
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status(), 503),
        other => panic!("expected 503, got {:?}", other.map(|_| ())),
    }
    drop(a);
    rig.event_where(|v| v["event"] == "disconnected" && v["conn"] == 1)
        .await;
    let _c = rig.connect().await;
    let connected = rig
        .event_where(|v| v["event"] == "connected" && v["conn"] == 3)
        .await;
    assert_eq!(connected["conn"], 3);
    drop(b);
}

/// Fast pings, and an idle timeout no stall a test tolerates can reach: for tests that need the
/// connection to stay open.
fn open_timings() -> common::Timings {
    common::Timings {
        idle_timeout: Duration::from_secs(600),
        ..fast_timings()
    }
}

fn live_cfg() -> common::Config {
    common::Config {
        down_rate: 0,
        timings: open_timings(),
        ..base_config()
    }
}

#[tokio::test]
async fn the_stub_pings_and_a_polling_client_stays_connected() {
    let rig = start(live_cfg()).await;
    let mut ws = rig.connect().await;
    // Wait for the third ping under a generous deadline; a stalled machine only delays it.
    let mut pings = 0;
    timeout(Duration::from_secs(20), async {
        while pings < 3 {
            match ws.next().await.expect("closed").expect("error") {
                Message::Ping(_) => pings += 1,
                Message::Close(f) => panic!("closed: {f:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("three pings");
    assert_eq!(pings, 3);
}

#[tokio::test]
async fn a_silent_client_times_out_and_frees_its_slot() {
    let mut rig = start(common::Config {
        max_connections: 1,
        down_rate: 0,
        // The timeout is what is tested, so it is short here.
        timings: fast_timings(),
        ..base_config()
    })
    .await;
    let _silent = rig.connect().await;
    let d = rig.event("disconnected").await;
    assert_eq!(d["reason"], "timeout");
    let _again = rig.connect().await;
}

#[tokio::test]
async fn a_client_close_is_peer_closed() {
    let mut rig = start(live_cfg()).await;
    let mut ws = rig.connect().await;
    ws.close(None).await.unwrap();
    assert_eq!(rig.event("disconnected").await["reason"], "peer_closed");
}

#[tokio::test]
async fn a_dropped_connection_is_peer_lost() {
    let mut rig = start(live_cfg()).await;
    let ws = rig.connect().await;
    rig.event("connected").await;
    drop(ws);
    assert_eq!(rig.event("disconnected").await["reason"], "peer_lost");
}

fn head_len(size: usize) -> usize {
    match size {
        0..=23 => 1,
        24..=255 => 2,
        256..=65535 => 3,
        _ => 5,
    }
}

#[tokio::test]
async fn downlink_frames_have_the_size_and_are_well_formed_cbor() {
    for size in [0usize, 23, 24, 255, 256, 65535, 65536, 1_048_576] {
        let rig = start(common::Config {
            down_rate: 20,
            down_size: size,
            ..base_config()
        })
        .await;
        // Include connection setup: a delayed test task may find several frames already buffered.
        let started = Instant::now();
        let mut ws = rig.connect().await;
        let mut n = 0u64;
        while n < 3 {
            let f = next_binary(&mut ws).await;
            assert_eq!(f.len(), size + head_len(size), "size {size}");
            assert!(is_well_formed(&f), "size {size}");
            n += 1;
            assert!(
                f64::from(u32::try_from(n).unwrap())
                    <= 20.0 * started.elapsed().as_secs_f64() + 1.0
            );
        }
    }
}

#[tokio::test]
async fn rate_zero_sends_no_data_frames() {
    let rig = start(live_cfg()).await;
    let mut ws = rig.connect().await;
    // No data frame may arrive up to the moment the first ping does.
    timeout(Duration::from_secs(20), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(_))) => panic!("data frame at rate 0"),
                Some(Ok(Message::Ping(_))) => break,
                Some(Ok(_)) => {}
                other => panic!("connection ended: {other:?}"),
            }
        }
    })
    .await
    .expect("a ping");
}

#[tokio::test]
async fn uplink_is_counted_and_never_interpreted() {
    let mut rig = start(common::Config {
        down_rate: 0,
        max_up_size: 100,
        ..base_config()
    })
    .await;
    let mut ws = rig.connect().await;
    let good: Vec<Vec<u8>> = vec![
        vec![0x18, 0x64],
        vec![0x20],
        vec![0x41, 0x00],
        vec![0x62, b'h', b'i'],
        vec![0x82, 0x01, 0x82, 0x02, 0x03],
        vec![0xa1, 0x61, 0x61, 0x01],
        vec![0xc1, 0x1a, 0x51, 0x4b, 0x67, 0xb0],
        vec![0xf5],
        vec![0xfb, 0x3f, 0xf1, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a],
        [vec![0x81; 63], vec![0x80]].concat(),
    ];
    let bad: Vec<Vec<u8>> = vec![
        vec![0x82, 0x01],
        vec![0x01, 0x02],
        vec![0x81; 70],
        vec![0x1c],
        vec![],
    ];
    let secret = b"SECRETPAYLOAD";
    let mut tagged = vec![0x4d];
    tagged.extend_from_slice(secret);
    for f in good.iter().chain(&bad).chain(std::iter::once(&tagged)) {
        ws.send(Message::Binary(f.clone().into())).await.unwrap();
    }
    let total: usize = good
        .iter()
        .chain(&bad)
        .chain(std::iter::once(&tagged))
        .map(Vec::len)
        .sum();
    // Stats show the counters; the connection stays open and nothing is replied.
    let s = rig
        .event_where(|v| v["event"] == "stats" && v["received"] == 16)
        .await;
    assert_eq!(s["malformed"], 5);
    assert_eq!(s["received_bytes"], total);
    ws.close(None).await.unwrap();
    let d = rig.event("disconnected").await;
    assert_eq!(d["reason"], "peer_closed");
    assert_eq!(d["malformed"], 5);
    assert!(!d.to_string().contains("SECRETPAYLOAD") && !s.to_string().contains("SECRETPAYLOAD"));
}

#[tokio::test]
async fn oversized_and_text_frames_close_the_connection() {
    let mut rig = start(common::Config {
        down_rate: 0,
        max_up_size: 100,
        ..base_config()
    })
    .await;
    for (len, name) in [(101usize, "just over"), (1_500_000, "far over")] {
        let mut ws = rig.connect().await;
        let _ = ws.send(Message::Binary(vec![0x41; len].into())).await;
        assert_eq!(
            close_code(&mut ws).await,
            u16::from(CloseCode::Size),
            "{name}"
        );
        let d = rig.event("disconnected").await;
        assert_eq!(d["reason"], "too_big", "{name}");
    }
    let mut ws = rig.connect().await;
    ws.send(Message::Text("hello".into())).await.unwrap();
    assert_eq!(close_code(&mut ws).await, 1003);
    assert_eq!(rig.event("disconnected").await["reason"], "text_frame");
    // Exactly the maximum is accepted.
    let mut ws = rig.connect().await;
    ws.send(Message::Binary(
        vec![0x58, 98]
            .into_iter()
            .chain(vec![0; 98])
            .collect::<Vec<u8>>()
            .into(),
    ))
    .await
    .unwrap();
    let s = rig
        .event_where(|v| v["event"] == "stats" && v["received"] == 1)
        .await;
    assert_eq!(s["malformed"], 0);
}

#[tokio::test]
async fn a_peer_that_stops_reading_costs_the_others_nothing() {
    // The idle timeout is out of reach, so a stall can end neither connection; the timeout of a
    // stalled peer is the next test's.
    let mut rig = start(common::Config {
        down_rate: 100,
        down_size: 1 << 20,
        timings: open_timings(),
        ..base_config()
    })
    .await;
    let _stalled = rig.connect().await;
    let mut reader = rig.connect().await;
    let mut got = 0;
    let mut stalled_skips = false;
    // The reader keeps receiving (and sending) until the stalled connection's cumulative counters
    // show skipped ticks. A closed or failed stream ends the test instead of spinning.
    timeout(Duration::from_secs(60), async {
        while got < 3 || !stalled_skips {
            tokio::select! {
                v = rig.events.recv() => {
                    let v = v.expect("events ended");
                    assert_ne!(v["event"], "disconnected", "{v}");
                    if v["event"] == "stats" && v["conn"] == 1 && v["skipped"].as_u64().unwrap() > 0 {
                        stalled_skips = true;
                    }
                }
                m = reader.next() => match m.expect("closed").expect("error") {
                    Message::Binary(b) => {
                        assert!(is_well_formed(&b));
                        got += 1;
                        reader.send(Message::Binary(vec![0x00].into())).await.unwrap();
                    }
                    Message::Close(f) => panic!("closed: {f:?}"),
                    _ => {}
                },
            }
        }
    })
    .await
    .expect("frames for the reader and skipped ticks for the stalled peer");
}

#[tokio::test]
async fn a_peer_that_stops_reading_and_answering_times_out() {
    // Alone on its stub, so the short idle timeout can end no connection that should stay open.
    let mut rig = start(common::Config {
        down_rate: 100,
        down_size: 1 << 20,
        timings: common::Timings {
            idle_timeout: Duration::from_secs(2),
            ..fast_timings()
        },
        ..base_config()
    })
    .await;
    let _stalled = rig.connect().await;
    let d = rig.event("disconnected").await;
    assert_eq!(d["conn"], 1);
    assert_eq!(d["reason"], "timeout");
}

#[tokio::test]
async fn stopping_closes_a_reading_connection_with_1001() {
    // An idle writer and no deadline a stall could reach: the close frame cannot be lost to a
    // timer, so the reading client must receive 1001.
    let mut rig = start(common::Config {
        down_rate: 0,
        timings: common::Timings {
            idle_timeout: Duration::from_secs(600),
            close_grace: Duration::from_secs(600),
            shutdown_deadline: Duration::from_secs(600),
            ..common::Timings::default()
        },
        ..base_config()
    })
    .await;
    assert_eq!(rig.event("listening").await["event"], "listening");
    let mut reading = rig.connect().await;
    rig.event("connected").await;
    rig.stop();
    assert_eq!(close_code(&mut reading).await, 1001);
    let d = rig.event("disconnected").await;
    assert_eq!(d["conn"], 1);
    assert_eq!(d["reason"], "shutdown");
    let task = rig.task.take().unwrap();
    timeout(Duration::from_secs(20), task)
        .await
        .expect("run returned")
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn stopping_returns_in_time_when_a_peer_has_stopped_reading() {
    // The peer never reads, so no close frame is expected here; the bound is AC-13's 5 seconds.
    let mut rig = start(common::Config {
        down_rate: 100,
        down_size: 1 << 20,
        timings: common::Timings {
            shutdown_deadline: Duration::from_secs(3),
            ..open_timings()
        },
        ..base_config()
    })
    .await;
    let _stalled = rig.connect().await;
    // Skipped ticks show the writer is held by the peer before the stub is told to stop.
    rig.event_where(|v| {
        v["event"] == "stats" && v["conn"] == 1 && v["skipped"].as_u64().unwrap() > 0
    })
    .await;
    rig.stop();
    let task = rig.task.take().unwrap();
    timeout(Duration::from_secs(5), task)
        .await
        .expect("run returned")
        .unwrap()
        .unwrap();
    let d = rig.event("disconnected").await;
    assert_eq!(d["conn"], 1);
    assert_eq!(d["reason"], "shutdown");
}
