//! The spike clock: 1 Hz, 64 by 32. Time, date, a seconds bar and a seconds circle, on black
//! grounds so it stays readable over an image (positions and colours: spec 107, `design/flow.md`).

#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_code)]

use panelator_widget::{Color, Font, Widget, draw, time};

const BLACK: Color = Color::BLACK;
const WHITE: Color = Color::WHITE;
const CYAN: Color = Color(0x4FD8_FFFF);
const AMBER: Color = Color(0xFFB0_00FF);
const GREEN: Color = Color(0x5CFF_8AFF);

/// The local time and date as text, and the local second.
#[derive(Debug, PartialEq, Eq)]
pub struct Formatted {
    /// `HH:MM:SS`.
    pub time: [u8; 8],
    /// `YYYY-MM-DD`.
    pub date: [u8; 10],
    /// The second, 0 to 59.
    pub second: u8,
}

impl Formatted {
    /// The time as a string.
    #[must_use]
    pub fn time_str(&self) -> &str {
        core::str::from_utf8(&self.time).unwrap_or("")
    }

    /// The date as a string.
    #[must_use]
    pub fn date_str(&self) -> &str {
        core::str::from_utf8(&self.date).unwrap_or("")
    }
}

fn two(n: u8) -> [u8; 2] {
    [b'0' + n / 10 % 10, b'0' + n % 10]
}

/// Formats the local time of `unix_ms` in a timezone `offset_s` seconds east of UTC.
#[must_use]
pub fn format(unix_ms: i64, offset_s: i32) -> Formatted {
    let now = time::local(unix_ms, offset_s);
    let hours = two(now.hour);
    let minutes = two(now.minute);
    let seconds = two(now.second);
    let year = u32::try_from(now.year).unwrap_or(0) % 10_000;
    let digit = |place: u32| b'0' + u8::try_from(year / place % 10).unwrap_or(0);
    let month = two(now.month);
    let day = two(now.day);
    Formatted {
        time: [
            hours[0], hours[1], b':', minutes[0], minutes[1], b':', seconds[0], seconds[1],
        ],
        date: [
            digit(1000),
            digit(100),
            digit(10),
            digit(1),
            b'-',
            month[0],
            month[1],
            b'-',
            day[0],
            day[1],
        ],
        second: now.second,
    }
}

/// The widget.
pub struct Clock;

impl Widget for Clock {
    const UPDATE_HZ: u8 = 1;
    const SIZE: (u16, u16) = (64, 32);

    fn init() -> Self {
        Clock
    }

    fn update(&mut self, _tick: u64) {
        let f = format(time::now(), time::utc_offset());
        let (time_s, date_s) = (f.time_str(), f.date_str());
        let second = i32::from(f.second);
        draw::fill(Color::TRANSPARENT);
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            draw::text(Font::Spleen8x16, dx, dy, time_s, BLACK);
        }
        draw::text(Font::Spleen8x16, 0, 0, time_s, WHITE);
        draw::fill_rect(0, 13, 64, 11, BLACK);
        draw::line(0, 14, 63, 14, CYAN);
        draw::rect(1, 17, 62, 5, CYAN);
        draw::fill_rect(2, 18, second, 3, AMBER);
        for x in [2, 17, 32, 47] {
            draw::pixel(x, 22, WHITE);
        }
        for (dx, dy) in [(0, 24), (2, 24), (1, 23), (1, 25)] {
            draw::text(Font::Spleen5x8, dx, dy, date_s, BLACK);
        }
        draw::text(Font::Spleen5x8, 1, 24, date_s, WHITE);
        draw::fill_circle(59, 27, 4, BLACK);
        if second % 2 == 0 {
            draw::fill_circle(59, 27, 3, GREEN);
        } else {
            draw::circle(59, 27, 3, GREEN);
        }
    }
}

panelator_widget::widget!(Clock);

#[cfg(test)]
mod tests {
    use super::format;

    const START: i64 = 1_798_757_998_000;

    #[test]
    fn two_seconds_before_midnight_and_at_midnight() {
        // Tick 0 and tick 120 of the conformance scene: start + (tick * 1000) / 60, offset 3600.
        let f = format(START, 3600);
        assert_eq!(
            (f.time_str(), f.date_str(), f.second),
            ("23:59:58", "2026-12-31", 58)
        );
        let f = format(START + 120 * 1000 / 60, 3600);
        assert_eq!(
            (f.time_str(), f.date_str(), f.second),
            ("00:00:00", "2027-01-01", 0)
        );
        assert_eq!(
            format(START + 59 * 1000 / 60 + 1000, 3600).time_str(),
            "23:59:59"
        );
    }
}
