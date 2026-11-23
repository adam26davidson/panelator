//! Time and timezone: the host's clock and the arithmetic that turns it into a local date.

use crate::sys;

/// The current time in milliseconds since the Unix epoch, UTC.
#[must_use]
pub fn now() -> i64 {
    // SAFETY: `time_unix_ms` takes no arguments and only returns a number.
    unsafe { sys::time_unix_ms() }
}

/// The offset of the board's timezone in effect now, in seconds east of UTC.
#[must_use]
pub fn utc_offset() -> i32 {
    // SAFETY: `time_utc_offset_s` takes no arguments and only returns a number.
    unsafe { sys::time_utc_offset_s() }
}

/// A date and a time of day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateTime {
    /// The year (proleptic Gregorian calendar).
    pub year: i32,
    /// The month, 1 to 12.
    pub month: u8,
    /// The day of the month, 1 to 31.
    pub day: u8,
    /// The hour, 0 to 23.
    pub hour: u8,
    /// The minute, 0 to 59.
    pub minute: u8,
    /// The second, 0 to 59.
    pub second: u8,
}

/// The local date and time for `unix_ms` (milliseconds since the epoch, UTC) in a timezone
/// `offset_s` seconds east of UTC.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "each value is range-checked by its modulus"
)]
pub fn local(unix_ms: i64, offset_s: i32) -> DateTime {
    let secs = unix_ms.div_euclid(1000) + i64::from(offset_s);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Civil from days (H. Hinnant's algorithm), days since 1970-01-01.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    DateTime {
        year: year as i32,
        month: month as u8,
        day: day as u8,
        hour: (tod / 3600) as u8,
        minute: (tod % 3600 / 60) as u8,
        second: (tod % 60) as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(year: i32, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> DateTime {
        DateTime {
            year,
            month,
            day,
            hour,
            minute,
            second,
        }
    }

    #[test]
    fn the_epoch() {
        assert_eq!(local(0, 0), dt(1970, 1, 1, 0, 0, 0));
        assert_eq!(local(999, 0), dt(1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn a_leap_day() {
        // 2024-02-29 12:34:56 UTC
        assert_eq!(local(1_709_210_096_000, 0), dt(2024, 2, 29, 12, 34, 56));
        // 2000-02-29 00:00:00 UTC (a century leap year)
        assert_eq!(local(951_782_400_000, 0), dt(2000, 2, 29, 0, 0, 0));
    }

    #[test]
    fn a_years_last_second() {
        assert_eq!(local(1_798_761_599_000, 0), dt(2026, 12, 31, 23, 59, 59));
        assert_eq!(local(1_798_761_600_000, 0), dt(2027, 1, 1, 0, 0, 0));
    }

    #[test]
    fn negative_offsets_and_dates_before_the_epoch() {
        assert_eq!(local(0, -3600), dt(1969, 12, 31, 23, 0, 0));
        assert_eq!(local(0, -5 * 3600 - 1800), dt(1969, 12, 31, 18, 30, 0));
        assert_eq!(local(-1000, 0), dt(1969, 12, 31, 23, 59, 59));
    }

    #[test]
    fn positive_offset_crosses_the_year() {
        assert_eq!(local(1_798_757_998_000, 3600), dt(2026, 12, 31, 23, 59, 58));
        assert_eq!(local(1_798_758_000_000, 3600), dt(2027, 1, 1, 0, 0, 0));
    }
}
