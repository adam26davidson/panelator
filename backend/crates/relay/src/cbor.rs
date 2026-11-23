//! The only CBOR the stub deals in: byte-string filler going out and a well-formedness check on
//! what comes in (RFC 8949 section 3 and Appendix C). The check never builds or looks at a value.

use bytes::{BufMut, Bytes, BytesMut};

/// The deepest nesting of arrays, maps, tags and indefinite-length strings the check accepts.
pub const MAX_NESTING: usize = 64;

/// One definite-length CBOR byte string of `size` content bytes, in its shortest encoding.
///
/// The content is filler: it means nothing and may change in any release.
#[must_use]
pub fn filler_frame(size: usize) -> Bytes {
    let mut buf = BytesMut::with_capacity(size + 9);
    if let Ok(n) = u8::try_from(size) {
        if n < 24 {
            buf.put_u8(0x40 | n);
        } else {
            buf.put_u8(0x58);
            buf.put_u8(n);
        }
    } else if let Ok(n) = u16::try_from(size) {
        buf.put_u8(0x59);
        buf.put_u16(n);
    } else {
        buf.put_u8(0x5a);
        buf.put_u32(u32::try_from(size).unwrap_or(u32::MAX));
    }
    buf.resize(buf.len() + size, 0xa5);
    buf.freeze()
}

/// What is open on the stack while an item is being read.
#[derive(Clone, Copy)]
enum Open {
    /// An array, map or tag with this many data items still to come.
    Definite(u128),
    /// An indefinite-length array.
    Array,
    /// An indefinite-length map and how many items it holds so far.
    Map(u64),
    /// An indefinite-length string of this major type (2 or 3).
    Chunks(u8),
}

/// Whether `data` is exactly one well-formed CBOR data item with no bytes after it.
///
/// Iterative, with a stack of at most [`MAX_NESTING`] entries; deeper nesting is malformed.
#[must_use]
pub fn is_well_formed(data: &[u8]) -> bool {
    check(data).is_some()
}

fn read_arg(data: &[u8], pos: &mut usize, ai: u8) -> Option<u64> {
    let width = match ai {
        0..=23 => return Some(u64::from(ai)),
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => return None,
    };
    let end = pos.checked_add(width)?;
    let bytes = data.get(*pos..end)?;
    *pos = end;
    Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

fn skip(data: &[u8], pos: &mut usize, len: u64) -> Option<()> {
    let end = pos.checked_add(usize::try_from(len).ok()?)?;
    if end > data.len() {
        return None;
    }
    *pos = end;
    Some(())
}

/// An item (leaf or whole container) has just finished: count it into what encloses it.
/// Returns true when the outermost item is complete.
fn complete(stack: &mut Vec<Open>) -> bool {
    while let Some(top) = stack.last_mut() {
        match top {
            Open::Definite(n) => {
                *n -= 1;
                if *n == 0 {
                    stack.pop();
                } else {
                    return false;
                }
            }
            Open::Map(n) => {
                *n += 1;
                return false;
            }
            Open::Array | Open::Chunks(_) => return false,
        }
    }
    true
}

fn check(data: &[u8]) -> Option<()> {
    let mut stack: Vec<Open> = Vec::with_capacity(MAX_NESTING);
    let mut pos = 0usize;
    loop {
        let ib = *data.get(pos)?;
        pos += 1;
        let (major, ai) = (ib >> 5, ib & 31);
        if (28..=30).contains(&ai) {
            return None;
        }
        if let Some(Open::Chunks(m)) = stack.last().copied() {
            // Only a break or a definite chunk of the same major type may appear here.
            if ib == 0xff {
                stack.pop();
                if complete(&mut stack) {
                    return (pos == data.len()).then_some(());
                }
            } else if major == m && ai != 31 {
                let len = read_arg(data, &mut pos, ai)?;
                skip(data, &mut pos, len)?;
            } else {
                return None;
            }
            continue;
        }
        let mut done = false;
        match (major, ai) {
            (0 | 1 | 6, 31) => return None,
            (0 | 1, _) => {
                read_arg(data, &mut pos, ai)?;
                done = true;
            }
            (2 | 3, 31) => {
                if stack.len() >= MAX_NESTING {
                    return None;
                }
                stack.push(Open::Chunks(major));
            }
            (2 | 3, _) => {
                let len = read_arg(data, &mut pos, ai)?;
                skip(data, &mut pos, len)?;
                done = true;
            }
            (4 | 5, 31) => {
                if stack.len() >= MAX_NESTING {
                    return None;
                }
                stack.push(if major == 4 {
                    Open::Array
                } else {
                    Open::Map(0)
                });
            }
            (4 | 5, _) => {
                let len = read_arg(data, &mut pos, ai)?;
                let items = u128::from(len) * if major == 5 { 2 } else { 1 };
                if stack.len() >= MAX_NESTING {
                    return None;
                }
                if items == 0 {
                    done = true;
                } else {
                    stack.push(Open::Definite(items));
                }
            }
            (6, _) => {
                read_arg(data, &mut pos, ai)?;
                if stack.len() >= MAX_NESTING {
                    return None;
                }
                stack.push(Open::Definite(1));
            }
            (_, 31) => match stack.last().copied() {
                Some(Open::Array) => {
                    stack.pop();
                    done = true;
                }
                Some(Open::Map(n)) if n % 2 == 0 => {
                    stack.pop();
                    done = true;
                }
                _ => return None,
            },
            (_, 24) => {
                if read_arg(data, &mut pos, ai)? < 32 {
                    return None;
                }
                done = true;
            }
            _ => {
                read_arg(data, &mut pos, ai)?;
                done = true;
            }
        }
        if done && complete(&mut stack) {
            return (pos == data.len()).then_some(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Examples from RFC 8949 Appendix A, every major type and head width.
    const GOOD: &[&str] = &[
        "00",
        "17",
        "1818",
        "1903e8",
        "1a000f4240",
        "1b000000e8d4a51000",
        "1bffffffffffffffff",
        "20",
        "29",
        "3863",
        "3903e7",
        "3bffffffffffffffff",
        "c249010000000000000000",
        "40",
        "4401020304",
        "60",
        "6161",
        "6449455446",
        "62225c",
        "62c3bc",
        "80",
        "83010203",
        "8301820203820405",
        "a0",
        "a201020304",
        "a26161016162820203",
        "826161a161626163",
        "a56161614161626142616361436164614461656145",
        "5f42010243030405ff",
        "7f657374726561646d696e67ff",
        "9fff",
        "9f018202039f0405ffff",
        "9f01820203820405ff",
        "83018202039f0405ff",
        "bf61610161629f0203ffff",
        "826161bf61626163ff",
        "bf6346756ef563416d7421ff",
        "c074323031332d30332d32315432303a30343a30305a",
        "c11a514b67b0",
        "d74401020304",
        "d818456449455446",
        "f4",
        "f5",
        "f6",
        "f7",
        "f0",
        "f8ff",
        "f90000",
        "f93c00",
        "f97bff",
        "fa47c35000",
        "fa7f800000",
        "fb3ff199999999999a",
        "fb7ff0000000000000",
        "7fff",
        "5fff",
        "c0c0c0f6",
        "bfff",
    ];

    #[test]
    fn appendix_a_examples_are_well_formed() {
        for h in GOOD {
            assert!(is_well_formed(&hex(h)), "{h}");
        }
    }

    #[test]
    fn truncated_by_one_byte_is_malformed() {
        for h in GOOD {
            let mut d = hex(h);
            d.pop();
            assert!(!is_well_formed(&d), "{h}");
        }
    }

    #[test]
    fn a_trailing_byte_is_malformed() {
        for h in GOOD {
            let mut d = hex(h);
            d.push(0);
            assert!(!is_well_formed(&d), "{h}");
        }
    }

    #[test]
    fn the_malformed_cases_of_appendix_f() {
        for h in [
            "",
            "1c",
            "1d",
            "1e",
            "3c",
            "5c",
            "7e",
            "9c",
            "bd",
            "dc",
            "fc",
            "fd",
            "fe",
            "1f",
            "3f",
            "df",
            "ff",
            "f801",
            "f818",
            "f81f",
            "5f01ff",
            "5f5fffff",
            "5f6161ff",
            "7f4161ff",
            "9fff00",
            "bf01ff",
            "bf0102ff00",
            "a1ff",
            "81ff",
            "5f",
            "9f",
            "bf",
            "c0",
            "a16161",
            "8200",
            "5b0000000100000000",
            "5bffffffffffffffff",
            "bbffffffffffffffff",
            "9bffffffffffffffff00",
            "dbffffffffffffffff",
            "5f40",
            "5fc0ff",
        ] {
            assert!(!is_well_formed(&hex(h)), "{h:?}");
        }
    }

    #[test]
    fn nesting_is_limited_to_64_levels() {
        let nested = |n: usize| {
            let mut d = vec![0x81; n - 1];
            d.push(0x80);
            d
        };
        assert!(is_well_formed(&nested(MAX_NESTING)));
        assert!(!is_well_formed(&nested(MAX_NESTING + 1)));
        let mut tags = vec![0xc0; MAX_NESTING + 1];
        tags.push(0);
        assert!(!is_well_formed(&tags));
    }

    #[test]
    fn a_megabyte_of_array_heads_does_not_overflow_the_stack() {
        assert!(!is_well_formed(&vec![0x81; 1 << 20]));
        assert!(!is_well_formed(&vec![0x9f; 1 << 20]));
    }

    #[test]
    fn filler_frames_have_the_shortest_head_and_are_well_formed() {
        for (size, head) in [
            (0, 1),
            (23, 1),
            (24, 2),
            (255, 2),
            (256, 3),
            (65535, 3),
            (65536, 5),
            (1 << 20, 5),
        ] {
            let f = filler_frame(size);
            assert_eq!(f.len(), size + head, "{size}");
            assert_eq!(f[0] >> 5, 2);
            assert!(is_well_formed(&f), "{size}");
        }
    }
}
