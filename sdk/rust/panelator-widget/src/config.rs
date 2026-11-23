//! Reading the placement's config: one JSON document whose top level is an object.
//!
//! [`read`] copies the document out of the host; [`str`], [`i64`] and [`bool`] read a top-level
//! member of it by key without an allocator. A missing key, a member of another type, a document
//! that is not an object and a truncated document all give `None`.

use crate::sys;

/// The length of the config in bytes.
#[must_use]
pub fn len() -> usize {
    // SAFETY: `config_len` takes no arguments and only returns a number.
    let n = unsafe { sys::config_len() };
    usize::try_from(n).unwrap_or(0)
}

/// Copies the first `min(buf.len(), len())` bytes of the config into `buf` and returns the count.
pub fn read(buf: &mut [u8]) -> usize {
    let cap = i32::try_from(buf.len()).unwrap_or(i32::MAX);
    // SAFETY: the host writes at most `cap` bytes, and `buf` is `cap` bytes or more.
    let n = unsafe { sys::config_read(crate::ptr_arg(buf.as_mut_ptr()), cap) };
    usize::try_from(n).unwrap_or(0).min(buf.len())
}

/// The string member `key` of the object `doc`, unescaped into `out`.
///
/// `None` when the key is missing, the member is not a string, `out` is too small or the
/// document is malformed.
#[must_use]
pub fn str<'a>(doc: &[u8], key: &str, out: &'a mut [u8]) -> Option<&'a str> {
    let at = find(doc, key)?;
    let n = unescape(doc, at, out)?.0;
    core::str::from_utf8(&out[..n]).ok()
}

/// The integer member `key` of the object `doc`. A number with a fraction or an exponent is not one.
#[must_use]
pub fn i64(doc: &[u8], key: &str) -> Option<i64> {
    let at = find(doc, key)?;
    let mut i = at;
    let neg = doc.get(i) == Some(&b'-');
    if neg {
        i += 1;
    }
    let start = i;
    let mut v: i64 = 0;
    while let Some(&c) = doc.get(i) {
        if !c.is_ascii_digit() {
            break;
        }
        let d = i64::from(c - b'0');
        v = v.checked_mul(10)?.checked_sub(d)?;
        i += 1;
    }
    if i == start || (doc[start] == b'0' && i - start > 1) {
        return None;
    }
    // The number must end here: a fraction, an exponent or a truncated document is not an integer.
    match doc.get(i)? {
        b',' | b'}' | b' ' | b'\t' | b'\n' | b'\r' => {}
        _ => return None,
    }
    if neg { Some(v) } else { v.checked_neg() }
}

/// The boolean member `key` of the object `doc`.
#[must_use]
pub fn bool(doc: &[u8], key: &str) -> Option<bool> {
    let at = find(doc, key)?;
    let (word, v) = if doc[at..].starts_with(b"true") {
        (4, true)
    } else if doc[at..].starts_with(b"false") {
        (5, false)
    } else {
        return None;
    };
    match doc.get(at + word)? {
        b',' | b'}' | b' ' | b'\t' | b'\n' | b'\r' => Some(v),
        _ => None,
    }
}

fn skip_ws(doc: &[u8], mut i: usize) -> usize {
    while matches!(doc.get(i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        i += 1;
    }
    i
}

/// Decodes the JSON string starting at `doc[at]` (the opening quote) into `out`.
/// Returns the byte count written and the index after the closing quote. `out` may be empty:
/// then only the bytes are counted (nothing is written, and an `out` too small gives `None`).
fn unescape(doc: &[u8], at: usize, out: &mut [u8]) -> Option<(usize, usize)> {
    if doc.get(at) != Some(&b'"') {
        return None;
    }
    let mut i = at + 1;
    let mut n = 0;
    loop {
        let c = *doc.get(i)?;
        i += 1;
        let ch = match c {
            b'"' => return Some((n, i)),
            b'\\' => {
                let e = *doc.get(i)?;
                i += 1;
                match e {
                    b'"' | b'\\' | b'/' => char::from(e),
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let hi = hex4(doc, i)?;
                        i += 4;
                        if (0xD800..0xDC00).contains(&hi) {
                            if doc.get(i) != Some(&b'\\') || doc.get(i + 1) != Some(&b'u') {
                                return None;
                            }
                            let lo = hex4(doc, i + 2)?;
                            i += 6;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return None;
                            }
                            char::from_u32(0x1_0000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))?
                        } else {
                            char::from_u32(hi)?
                        }
                    }
                    _ => return None,
                }
            }
            0..=0x1f => return None,
            0x20..=0x7f => char::from(c),
            _ => {
                // A multi-byte UTF-8 sequence is copied whole; the document is UTF-8.
                let len = match c {
                    0xC0..=0xDF => 2,
                    0xE0..=0xEF => 3,
                    0xF0..=0xF7 => 4,
                    _ => return None,
                };
                let seq = doc.get(i - 1..i - 1 + len)?;
                let s = core::str::from_utf8(seq).ok()?;
                i += len - 1;
                s.chars().next()?
            }
        };
        let mut tmp = [0u8; 4];
        let enc = ch.encode_utf8(&mut tmp).as_bytes();
        out.get_mut(n..n + enc.len())?.copy_from_slice(enc);
        n += enc.len();
    }
}

fn hex4(doc: &[u8], i: usize) -> Option<u32> {
    let mut v = 0;
    for k in 0..4 {
        v = v * 16 + char::from(*doc.get(i + k)?).to_digit(16)?;
    }
    Some(v)
}

/// Whether the string at `at` equals `key` once unescaped; returns the index after it.
fn key_matches(doc: &[u8], at: usize, key: &str) -> Option<(bool, usize)> {
    let mut buf = [0u8; 64];
    // A key longer than the buffer cannot match a key the caller asks for in this SDK's use,
    // but it must still be skipped: count it with a second pass that writes nothing.
    if let Some((n, end)) = unescape(doc, at, &mut buf) {
        Some((&buf[..n] == key.as_bytes(), end))
    } else {
        Some((false, skip_string(doc, at)?))
    }
}

fn skip_string(doc: &[u8], at: usize) -> Option<usize> {
    let mut i = at + 1;
    loop {
        match *doc.get(i)? {
            b'"' => return Some(i + 1),
            b'\\' => i += 2,
            _ => i += 1,
        }
    }
}

/// Skips one value starting at `at`; returns the index after it.
fn skip_value(doc: &[u8], at: usize) -> Option<usize> {
    match *doc.get(at)? {
        b'"' => skip_string(doc, at),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut i = at;
            loop {
                match *doc.get(i)? {
                    b'"' => {
                        i = skip_string(doc, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
        }
        _ => {
            let mut i = at;
            while !matches!(doc.get(i)?, b',' | b'}' | b']') {
                i += 1;
            }
            Some(i)
        }
    }
}

/// The index of the value of the top-level member `key`, after the colon and its whitespace.
fn find(doc: &[u8], key: &str) -> Option<usize> {
    let mut i = skip_ws(doc, 0);
    if doc.get(i) != Some(&b'{') {
        return None;
    }
    i = skip_ws(doc, i + 1);
    if doc.get(i) == Some(&b'}') {
        return None;
    }
    loop {
        let (hit, end) = key_matches(doc, i, key)?;
        i = skip_ws(doc, end);
        if doc.get(i) != Some(&b':') {
            return None;
        }
        i = skip_ws(doc, i + 1);
        if hit {
            return Some(i);
        }
        i = skip_ws(doc, skip_value(doc, i)?);
        match doc.get(i)? {
            b',' => i = skip_ws(doc, i + 1),
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_top_level_members_of_each_type() {
        let doc = br#" { "text": "hi", "n": -42, "on": true, "off": false } "#;
        let mut out = [0u8; 16];
        assert_eq!(str(doc, "text", &mut out), Some("hi"));
        assert_eq!(i64(doc, "n"), Some(-42));
        assert_eq!(bool(doc, "on"), Some(true));
        assert_eq!(bool(doc, "off"), Some(false));
    }

    #[test]
    fn missing_key_or_other_type_is_none() {
        let doc = br#"{"a": "x", "b": 1, "c": true}"#;
        let mut out = [0u8; 8];
        assert_eq!(str(doc, "zz", &mut out), None);
        assert_eq!(i64(doc, "a"), None);
        assert_eq!(bool(doc, "b"), None);
        assert_eq!(str(doc, "c", &mut out), None);
        assert_eq!(i64(br#"{"n": 1.5}"#, "n"), None);
        assert_eq!(i64(br#"{"n": 1e3}"#, "n"), None);
    }

    #[test]
    fn skips_nested_values_and_does_not_read_nested_keys() {
        let doc = br#"{"o": {"text": "inner", "a": [1, {"text": "x"}, "]}"]}, "text": "outer"}"#;
        let mut out = [0u8; 16];
        assert_eq!(str(doc, "text", &mut out), Some("outer"));
        assert_eq!(str(doc, "o", &mut out), None);
    }

    #[test]
    fn unescapes_strings_and_keys() {
        let mut out = [0u8; 32];
        assert_eq!(
            str(
                br#"{"s": "a\"b\\c\/d\n\t\u00e9\ud83d\ude00"}"#,
                "s",
                &mut out
            ),
            Some("a\"b\\c/d\n\té\u{1F600}")
        );
        assert_eq!(str(br#"{"k\u0065y": "v"}"#, "key", &mut out), Some("v"));
        assert_eq!(str("{\"s\": \"ü€\"}".as_bytes(), "s", &mut out), Some("ü€"));
    }

    #[test]
    fn string_too_long_for_the_buffer_is_none() {
        let mut out = [0u8; 2];
        assert_eq!(str(br#"{"s": "abc"}"#, "s", &mut out), None);
    }

    #[test]
    fn truncated_documents_are_none() {
        let mut out = [0u8; 8];
        for doc in [
            &br#"{"a": "xy"#[..],
            br#"{"a": 12"#,
            br#"{"a": tru"#,
            br#"{"a""#,
            br#"{"a": "\u12"}"#,
            b"{",
            b"",
        ] {
            assert_eq!(str(doc, "a", &mut out), None);
            assert_eq!(i64(doc, "a"), None);
            assert_eq!(bool(doc, "a"), None);
        }
    }

    #[test]
    fn a_document_that_is_not_an_object_is_none() {
        let mut out = [0u8; 8];
        for doc in [&br#"["a"]"#[..], br#""a""#, b"12", b"null", b"{}"] {
            assert_eq!(str(doc, "a", &mut out), None);
            assert_eq!(i64(doc, "a"), None);
            assert_eq!(bool(doc, "a"), None);
        }
    }

    #[test]
    fn integer_limits() {
        assert_eq!(i64(br#"{"n": 9223372036854775807}"#, "n"), Some(i64::MAX));
        assert_eq!(i64(br#"{"n": -9223372036854775808}"#, "n"), Some(i64::MIN));
        assert_eq!(i64(br#"{"n": 9223372036854775808}"#, "n"), None);
        assert_eq!(i64(br#"{"n": 01}"#, "n"), None);
        assert_eq!(i64(br#"{"n": -}"#, "n"), None);
    }
}
