//! The downlink generator and the counters of a connection (AC-9, AC-11).
//!
//! The generator is separate from the socket so that a test can run it under tokio's paused clock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::Notify;
use tokio::time::{Instant, interval_at};

/// The cumulative counters of one connection.
#[derive(Debug, Default)]
pub struct Counters {
    /// Data frames written to the peer.
    pub sent: AtomicU64,
    /// Content bytes of the frames written (`size` per frame).
    pub sent_bytes: AtomicU64,
    /// Ticks skipped because the previous frame had not been written.
    pub skipped: AtomicU64,
    /// Binary frames received.
    pub received: AtomicU64,
    /// Payload bytes of the frames received.
    pub received_bytes: AtomicU64,
    /// Received frames that were not well-formed CBOR.
    pub malformed: AtomicU64,
}

impl Counters {
    /// A snapshot as the event type.
    #[must_use]
    pub fn snapshot(&self) -> crate::events::Counts {
        let get = |a: &AtomicU64| a.load(Ordering::Relaxed);
        crate::events::Counts {
            sent: get(&self.sent),
            sent_bytes: get(&self.sent_bytes),
            skipped: get(&self.skipped),
            received: get(&self.received),
            received_bytes: get(&self.received_bytes),
            malformed: get(&self.malformed),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The one-frame slot between the generator and the writer.
#[derive(Debug, Default)]
pub struct Slot {
    frame: Mutex<Option<Bytes>>,
    notify: Notify,
}

impl Slot {
    /// Offers a frame; false when the previous one has not been written yet.
    fn offer(&self, frame: &Bytes) -> bool {
        let mut held = lock(&self.frame);
        if held.is_some() {
            return false;
        }
        *held = Some(frame.clone());
        drop(held);
        self.notify.notify_one();
        true
    }

    /// Waits for a frame and returns it; it stays in the slot until [`Slot::written`].
    pub async fn next_frame(&self) -> Bytes {
        loop {
            if let Some(f) = lock(&self.frame).clone() {
                return f;
            }
            self.notify.notified().await;
        }
    }

    /// The write of the frame completed: empties the slot and counts it.
    pub fn written(&self, counters: &Counters, content_bytes: u64) {
        *lock(&self.frame) = None;
        counters.sent.fetch_add(1, Ordering::Relaxed);
        counters
            .sent_bytes
            .fetch_add(content_bytes, Ordering::Relaxed);
    }

    /// Frames held, 0 or 1.
    #[must_use]
    pub fn held(&self) -> usize {
        usize::from(lock(&self.frame).is_some())
    }
}

/// Offers `frame` to `slot` at `rate` per second, the first one interval from now, on an absolute
/// timeline. Never returns; with rate 0 it sends nothing.
pub async fn generate(rate: u32, frame: Bytes, slot: Arc<Slot>, counters: Arc<Counters>) {
    if rate == 0 {
        std::future::pending::<()>().await;
    }
    let period = Duration::from_secs(1) / rate;
    let mut ticker = interval_at(Instant::now() + period, period);
    loop {
        ticker.tick().await;
        if !slot.offer(&frame) {
            counters.skipped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::filler_frame;

    /// Spawns a generator and a consumer that writes at once; returns the counters.
    fn start(rate: u32, consume: bool) -> (Arc<Slot>, Arc<Counters>) {
        let slot = Arc::new(Slot::default());
        let counters = Arc::new(Counters::default());
        let frame = filler_frame(10);
        tokio::spawn(generate(
            rate,
            frame.clone(),
            slot.clone(),
            counters.clone(),
        ));
        if consume {
            let (s, c) = (slot.clone(), counters.clone());
            tokio::spawn(async move {
                loop {
                    let f = s.next_frame().await;
                    s.written(&c, (f.len() - 1) as u64);
                }
            });
        }
        (slot, counters)
    }

    #[tokio::test(start_paused = true)]
    async fn the_frames_sent_are_rate_times_window() {
        for rate in [1u32, 3, 10, 1000] {
            for window in [5u64, 7, 20] {
                let (_slot, c) = start(rate, true);
                tokio::time::sleep(Duration::from_secs(window) + Duration::from_millis(1)).await;
                let sent = c.sent.load(Ordering::Relaxed);
                let want = u64::from(rate) * window;
                assert!(
                    sent.abs_diff(want) <= 1,
                    "rate {rate} window {window}: {sent}"
                );
                assert_eq!(c.sent_bytes.load(Ordering::Relaxed), sent * 10);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_frame_comes_one_interval_after_the_start() {
        let (_slot, c) = start(4, true);
        tokio::time::sleep(Duration::from_millis(249)).await;
        assert_eq!(c.sent.load(Ordering::Relaxed), 0);
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(c.sent.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn rate_zero_sends_nothing() {
        let (_slot, c) = start(0, true);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(c.sent.load(Ordering::Relaxed), 0);
        assert_eq!(c.skipped.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopped_consumer_skips_ticks_and_holds_one_frame() {
        let (slot, c) = start(10, false);
        tokio::time::sleep(Duration::from_millis(5005)).await;
        assert_eq!(c.sent.load(Ordering::Relaxed), 0);
        assert_eq!(slot.held(), 1);
        assert_eq!(c.skipped.load(Ordering::Relaxed), 49);
        // The consumer resumes: one frame now, then the rate with no burst of the skipped ones.
        let f = slot.next_frame().await;
        slot.written(&c, (f.len() - 1) as u64);
        assert_eq!(c.sent.load(Ordering::Relaxed), 1);
        let (s, c2) = (slot.clone(), c.clone());
        tokio::spawn(async move {
            loop {
                let f = s.next_frame().await;
                s.written(&c2, (f.len() - 1) as u64);
            }
        });
        tokio::time::sleep(Duration::from_secs(5)).await;
        let sent = c.sent.load(Ordering::Relaxed);
        assert!((50..=52).contains(&sent), "{sent}");
    }
}
