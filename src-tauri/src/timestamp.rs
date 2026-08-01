//! Formatting an instant as the exact ISO 8601 shape `capture_id` is derived
//! from: `YYYY-MM-DDTHH:MM:SS.sssZ`.
//!
//! Millisecond precision always, trailing zeros retained, `Z` rather than
//! `+00:00`. The format is fixed rather than merely described because the same
//! instant formatted two ways hashes two ways, and this value goes straight
//! into the id (`runtime.md` §3). The sidecar refuses anything else.
//!
//! Written out rather than pulled from a date crate: the host needs exactly one
//! format of exactly one calendar, and the civil-from-days algorithm below is
//! smaller than the dependency would be.

const MILLIS_PER_SECOND: i64 = 1_000;
const SECONDS_PER_DAY: i64 = 86_400;
const SECONDS_PER_HOUR: i64 = 3_600;
const SECONDS_PER_MINUTE: i64 = 60;

/// Milliseconds since the Unix epoch as ISO 8601 UTC.
pub fn format_iso8601(millis_since_epoch: i64) -> String {
    let seconds = millis_since_epoch.div_euclid(MILLIS_PER_SECOND);
    let millis = millis_since_epoch.rem_euclid(MILLIS_PER_SECOND);
    let (year, month, day) = civil_from_days(seconds.div_euclid(SECONDS_PER_DAY));
    let time_of_day = seconds.rem_euclid(SECONDS_PER_DAY);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        time_of_day / SECONDS_PER_HOUR,
        (time_of_day % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
        time_of_day % SECONDS_PER_MINUTE,
        millis
    )
}

/// Howard Hinnant's `civil_from_days`: a day number to a proleptic Gregorian
/// date, with the era arithmetic that makes leap years fall out rather than
/// being special-cased.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_epoch_itself() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn keeps_millisecond_precision_with_trailing_zeros() {
        // The trailing zeros are load-bearing: `.1` and `.100` are the same
        // instant and two different hash inputs.
        assert_eq!(format_iso8601(100), "1970-01-01T00:00:00.100Z");
        assert_eq!(format_iso8601(1), "1970-01-01T00:00:00.001Z");
    }

    #[test]
    fn formats_a_date_the_slice_uses_as_its_golden_value() {
        // 2026-08-01T09:00:00.000Z, the timestamp behind the pinned capture id.
        assert_eq!(format_iso8601(1_785_574_800_000), "2026-08-01T09:00:00.000Z");
    }

    #[test]
    fn handles_a_leap_day() {
        assert_eq!(format_iso8601(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn handles_the_last_second_of_a_year() {
        assert_eq!(format_iso8601(1_767_225_599_999), "2025-12-31T23:59:59.999Z");
    }

    #[test]
    fn always_produces_the_shape_the_sidecar_requires() {
        let pattern = regex_lite_matches;
        for millis in [0_i64, 1, 1_785_920_400_000, 1_767_225_599_999, 4_102_444_800_000] {
            assert!(pattern(&format_iso8601(millis)), "{}", format_iso8601(millis));
        }
    }

    /// `YYYY-MM-DDTHH:MM:SS.sssZ`, checked without a regex dependency.
    fn regex_lite_matches(value: &str) -> bool {
        let bytes = value.as_bytes();
        if bytes.len() != 24 {
            return false;
        }
        let digits_at = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
        let literals = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':'), (19, b'.')];
        digits_at.iter().all(|&at| bytes[at].is_ascii_digit())
            && literals.iter().all(|&(at, expected)| bytes[at] == expected)
            && bytes[23] == b'Z'
    }
}
