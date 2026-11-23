//! The layer and the rasteriser of `docs/widget-abi.md`.
//!
//! Every call produces exactly the pixel set of the document's pseudo-code, at a cost bounded by the
//! layer's size: lines and circles are clipped analytically, with 64 and 128-bit intermediates, so
//! that no argument can make a call walk pixels outside the layer or overflow.

/// A layer: RGBA pixels as `0xRRGGBBAA`, rows top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layer {
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// The pixels.
    pub pixels: Vec<u32>,
}

impl Layer {
    /// A transparent layer.
    #[must_use]
    pub fn new(width: usize, height: usize) -> Layer {
        Layer {
            width,
            height,
            pixels: vec![0; width * height],
        }
    }

    fn w(&self) -> i64 {
        i64::try_from(self.width).unwrap_or(i64::MAX)
    }

    fn h(&self) -> i64 {
        i64::try_from(self.height).unwrap_or(i64::MAX)
    }

    /// The pixel at `(x, y)`, or `None` outside the layer.
    #[must_use]
    pub fn get(&self, x: i64, y: i64) -> Option<u32> {
        self.index(x, y).map(|i| self.pixels[i])
    }

    #[allow(
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation,
        reason = "both are checked to be in 0..size first"
    )]
    fn index(&self, x: i64, y: i64) -> Option<usize> {
        ((0..self.w()).contains(&x) && (0..self.h()).contains(&y))
            .then(|| y as usize * self.width + x as usize)
    }

    /// Sets a pixel when it is inside the layer.
    pub fn set(&mut self, x: i64, y: i64, color: u32) {
        if let Some(i) = self.index(x, y) {
            self.pixels[i] = color;
        }
    }

    /// Sets the pixels of row `y` from `x0` to `x1` inclusive, clipped.
    #[allow(
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation,
        reason = "clamped to the layer first"
    )]
    fn hspan(&mut self, y: i64, x0: i64, x1: i64, color: u32) {
        if !(0..self.h()).contains(&y) {
            return;
        }
        let (a, b) = (x0.max(0), x1.min(self.w() - 1));
        if a > b {
            return;
        }
        let row = y as usize * self.width;
        self.pixels[row + a as usize..=row + b as usize].fill(color);
    }

    /// `draw_fill`: every pixel.
    pub fn fill(&mut self, color: u32) {
        self.pixels.fill(color);
    }

    /// `draw_pixel`.
    pub fn pixel(&mut self, x: i32, y: i32, color: u32) {
        self.set(i64::from(x), i64::from(y), color);
    }

    /// `draw_rect`: the `w` by `h` pixels from `(x, y)` when `filled`, else their border.
    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, color: u32, filled: bool) {
        if w <= 0 || h <= 0 {
            return;
        }
        let (x, y, w, h) = (i64::from(x), i64::from(y), i64::from(w), i64::from(h));
        let (x1, y1) = (x + w - 1, y + h - 1);
        if filled {
            for row in y.max(0)..=y1.min(self.h() - 1) {
                self.hspan(row, x, x1, color);
            }
            return;
        }
        self.hspan(y, x, x1, color);
        self.hspan(y1, x, x1, color);
        for row in y.max(0)..=y1.min(self.h() - 1) {
            self.set(x, row, color);
            self.set(x1, row, color);
        }
    }

    /// `draw_line`: Bresenham's line, both ends included.
    pub fn line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, color: u32) {
        let (x0, y0, x1, y1) = (i64::from(x0), i64::from(y0), i64::from(x1), i64::from(y1));
        let (dx, dy) = ((x1 - x0).abs(), (y1 - y0).abs());
        let (sx, sy) = (if x0 < x1 { 1 } else { -1 }, if y0 < y1 { 1 } else { -1 });
        if dx >= dy {
            // x-major: one pixel per column; the row follows the rounded slope.
            let (lo, hi) = clip_range(x0, sx, dx, self.w());
            for i in lo..=hi {
                self.set(x0 + sx * i, y0 + sy * minor_step(i, dx, dy), color);
            }
        } else {
            let (lo, hi) = clip_range(y0, sy, dy, self.h());
            for i in lo..=hi {
                self.set(x0 + sx * minor_step(i, dy, dx), y0 + sy * i, color);
            }
        }
    }

    /// `draw_circle`: the midpoint circle of radius `r` around `(cx, cy)`.
    pub fn circle(&mut self, cx: i32, cy: i32, r: i32, color: u32, filled: bool) {
        if r < 0 {
            return;
        }
        let (cx, cy, r) = (i64::from(cx), i64::from(cy), i64::from(r));
        if r == 0 {
            self.set(cx, cy, color);
            return;
        }
        let ymax = circle_ymax(r);
        for py in (cy - r).max(0)..=(cy + r).min(self.h() - 1) {
            let k = (py - cy).abs();
            let first = (k <= ymax).then(|| circle_x(r, k));
            let second = circle_second(r, k, ymax);
            if filled {
                let half = first.max(second.map(|s| s.1));
                if let Some(half) = half {
                    self.hspan(py, cx - half, cx + half, color);
                }
            } else {
                if let Some(h) = first {
                    self.set(cx - h, py, color);
                    self.set(cx + h, py, color);
                }
                if let Some((lo, hi)) = second {
                    // Columns lo..=hi on each side of the centre; clip before walking.
                    self.hspan(py, cx - hi, cx - lo, color);
                    self.hspan(py, cx + lo, cx + hi, color);
                }
            }
        }
    }
}

/// The range of step numbers `i` in `0..=d` for which `start + step * i` lies in `0..size`.
fn clip_range(start: i64, step: i64, d: i64, size: i64) -> (i64, i64) {
    // position p(i) = start + step * i; in range when 0 <= p < size.
    let (a, b) = if step > 0 {
        (-start, size - 1 - start)
    } else {
        (start - (size - 1), start)
    };
    (a.max(0), b.min(d))
}

/// For the line's major axis step `i` of `major` steps and `minor` minor steps, the number of
/// minor steps taken by then: the slope `minor / major` rounded, ties as the pseudo-code takes them.
fn minor_step(i: i64, major: i64, minor: i64) -> i64 {
    if major == 0 {
        return 0;
    }
    let num = 2 * i128::from(i) * i128::from(minor) + i128::from(major);
    i64::try_from(num / (2 * i128::from(major))).unwrap_or(i64::MAX)
}

/// The octant's x at offset `y` from the centre: the largest `x` with `x*x - x + y*y <= r*r - 1`.
fn circle_x(r: i64, y: i64) -> i64 {
    let m = i128::from(r) * i128::from(r) - 1 - i128::from(y) * i128::from(y);
    inv_xx(m).unwrap_or(-1)
}

/// The largest `x >= 0` with `x*x - x <= m`.
fn inv_xx(m: i128) -> Option<i64> {
    let m = u128::try_from(m).ok()?;
    let s = (1 + 4 * m).isqrt();
    i64::try_from(s.div_ceil(2)).ok()
}

/// The largest `y` of the octant loop: `x(y) >= y`, that is `2*y*y - y <= r*r - 1`.
fn circle_ymax(r: i64) -> i64 {
    let (mut lo, mut hi) = (0i64, r);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if 2 * i128::from(mid) * i128::from(mid) - i128::from(mid) < i128::from(r) * i128::from(r) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

/// The octant steps `y` in `0..=ymax` whose `x(y)` equals `k`: they put pixels at column offset
/// `y` on the row `k` from the centre. Returned as the inclusive range of those `y`.
fn circle_second(r: i64, k: i64, ymax: i64) -> Option<(i64, i64)> {
    // x(y) >= k  <=>  y*y <= r*r - 1 - k*k + k.
    let reach = |k: i64| {
        let m = i128::from(r) * i128::from(r) - 1 - i128::from(k) * i128::from(k) + i128::from(k);
        u128::try_from(m)
            .ok()
            .map(|m| i64::try_from(m.isqrt()).unwrap_or(i64::MAX))
    };
    let hi = reach(k)?.min(ymax);
    let lo = reach(k + 1).map_or(0, |v| v + 1);
    (lo <= hi).then_some((lo, hi))
}

#[cfg(test)]
mod tests;
