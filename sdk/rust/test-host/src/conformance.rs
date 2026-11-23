//! The conformance material that is computed rather than downloaded.

/// The bytes of `sdk/conformance/assets/spike-image.rgb`: 128 by 64, one frame, RGB. The pixel at
/// `(x, y)` is `R = (x * 255) / 127`, `G = (y * 255) / 63`, `B = 255` when `(x / 8 + y / 8)` is
/// even and 0 otherwise.
#[must_use]
pub fn spike_image() -> Vec<u8> {
    let mut v = Vec::with_capacity(128 * 64 * 3);
    for y in 0..64u32 {
        for x in 0..128u32 {
            v.push(u8::try_from(x * 255 / 127).unwrap_or(255));
            v.push(u8::try_from(y * 255 / 63).unwrap_or(255));
            v.push(if (x / 8 + y / 8) % 2 == 0 { 255 } else { 0 });
        }
    }
    v
}
