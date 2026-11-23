use super::Layer;

const C: u32 = 0x11223344;

/// A literal transcription of the document's pseudo-code: the sparse pixel list, unbounded.
mod reference {
    pub fn line(x0: i64, y0: i64, x1: i64, y1: i64) -> Vec<(i64, i64)> {
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let (mut err, mut x, mut y) = (dx + dy, x0, y0);
        let mut out = vec![];
        loop {
            out.push((x, y));
            if x == x1 && y == y1 {
                return out;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
    }

    pub fn circle(cx: i64, cy: i64, r: i64, filled: bool) -> Vec<(i64, i64)> {
        let mut out = vec![];
        if r < 0 {
            return out;
        }
        if r == 0 {
            return vec![(cx, cy)];
        }
        let mut row = |py: i64, h: i64| {
            if filled {
                out.extend((cx - h..=cx + h).map(|px| (px, py)));
            } else {
                out.push((cx - h, py));
                out.push((cx + h, py));
            }
        };
        let (mut x, mut y, mut d) = (r, 0, 1 - r);
        while x >= y {
            row(cy + y, x);
            row(cy - y, x);
            row(cy + x, y);
            row(cy - x, y);
            y += 1;
            if d < 0 {
                d += 2 * y + 1;
            } else {
                x -= 1;
                d += 2 * (y - x) + 1;
            }
        }
        out
    }
}

fn expected(w: usize, h: usize, pixels: &[(i64, i64)]) -> Layer {
    let mut l = Layer::new(w, h);
    for &(x, y) in pixels {
        l.set(x, y, C);
    }
    l
}

/// The lit pixels of a layer, as a sorted list.
fn lit(l: &Layer) -> Vec<(i64, i64)> {
    let mut v = vec![];
    for y in 0..l.height {
        for x in 0..l.width {
            if l.pixels[y * l.width + x] == C {
                v.push((i64::try_from(x).unwrap(), i64::try_from(y).unwrap()));
            }
        }
    }
    v
}

#[test]
fn lines_equal_the_pseudo_code_over_all_small_arguments() {
    for x0 in -5..14 {
        for y0 in -5..14 {
            for x1 in -5..14 {
                for y1 in -5..14 {
                    let mut l = Layer::new(9, 9);
                    l.line(x0, y0, x1, y1, C);
                    let want = expected(9, 9, &reference::line(i64::from(x0), i64::from(y0), i64::from(x1), i64::from(y1)));
                    assert_eq!(l, want, "line ({x0},{y0}) to ({x1},{y1})");
                }
            }
        }
    }
}

#[test]
fn circles_equal_the_pseudo_code_over_all_small_arguments() {
    for cx in -6..16 {
        for cy in -6..16 {
            for r in -1..12 {
                for filled in [false, true] {
                    let mut l = Layer::new(10, 10);
                    l.circle(cx, cy, r, C, filled);
                    let want = expected(10, 10, &reference::circle(i64::from(cx), i64::from(cy), i64::from(r), filled));
                    assert_eq!(l, want, "circle ({cx},{cy}) r {r} filled {filled}");
                }
            }
        }
    }
}

#[test]
fn circles_of_every_radius_up_to_300_equal_the_pseudo_code() {
    for r in 0..=300 {
        for filled in [false, true] {
            let mut l = Layer::new(81, 81);
            l.circle(40, 40, r, C, filled);
            // A window at the circle's edge, where the shape crosses the layer.
            assert_eq!(l, expected(81, 81, &reference::circle(40, 40, i64::from(r), filled)), "r {r} filled {filled}");
            let mut l = Layer::new(64, 64);
            l.circle(-i32::try_from(r).unwrap() + 20, 31, r, C, filled);
            assert_eq!(l, expected(64, 64, &reference::circle(-i64::from(r) + 20, 31, i64::from(r), filled)));
        }
    }
}

#[test]
fn rectangles_in_both_modes() {
    for (w, h) in [(0, 0), (0, 3), (1, 1), (1, 4), (2, 2), (3, 3), (5, 4)] {
        let mut f = Layer::new(8, 8);
        f.rect(1, 1, w, h, C, true);
        let mut b = Layer::new(8, 8);
        b.rect(1, 1, w, h, C, false);
        let (w, h) = (i64::from(w), i64::from(h));
        let fill: Vec<_> = (0..h).flat_map(|j| (0..w).map(move |i| (1 + i, 1 + j))).collect();
        let border: Vec<_> = fill.iter().copied().filter(|&(x, y)| x == 1 || y == 1 || x == w || y == h).collect();
        assert_eq!(f, expected(8, 8, &fill));
        assert_eq!(lit(&b).len(), border.len(), "border of {w}x{h}");
        assert_eq!(b, expected(8, 8, &border));
    }
    let mut l = Layer::new(8, 8);
    l.rect(2, 2, -3, 4, C, true);
    l.rect(2, 2, 3, 0, C, false);
    assert!(lit(&l).is_empty());
}

#[test]
fn horizontal_vertical_and_single_point_lines() {
    let mut l = Layer::new(6, 6);
    l.line(1, 2, 4, 2, C);
    assert_eq!(lit(&l), [(1, 2), (2, 2), (3, 2), (4, 2)]);
    let mut l = Layer::new(6, 6);
    l.line(3, 5, 3, 2, C);
    assert_eq!(lit(&l), [(3, 2), (3, 3), (3, 4), (3, 5)]);
    let mut l = Layer::new(6, 6);
    l.line(2, 2, 2, 2, C);
    assert_eq!(lit(&l), [(2, 2)]);
}

#[test]
fn the_eight_octants_from_the_centre() {
    for (dx, dy) in [(5, 2), (2, 5), (-2, 5), (-5, 2), (-5, -2), (-2, -5), (2, -5), (5, -2)] {
        let mut l = Layer::new(13, 13);
        l.line(6, 6, 6 + dx, 6 + dy, C);
        let want = expected(13, 13, &reference::line(6, 6, i64::from(6 + dx), i64::from(6 + dy)));
        assert_eq!(l, want, "octant {dx},{dy}");
        assert_eq!(lit(&l).len(), 6, "one pixel per major step");
    }
}

#[test]
fn radius_3_outline_and_radius_4_disc_as_the_design_lists() {
    let mut l = Layer::new(9, 9);
    l.circle(4, 4, 3, C, false);
    let mut want = vec![];
    for (x, y) in [(3, 0), (3, 1), (2, 2), (1, 3), (0, 3)] {
        for (sx, sy) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
            want.push((4 + x * sx, 4 + y * sy));
            want.push((4 + y * sx, 4 + x * sy));
        }
    }
    assert_eq!(l, expected(9, 9, &want));
    assert_eq!(lit(&l).len(), 16);
    let mut l = Layer::new(9, 9);
    l.circle(4, 4, 4, C, true);
    let widths: Vec<_> = (0..9).map(|y| lit(&l).iter().filter(|p| p.1 == y).count()).collect();
    assert_eq!(widths, [3, 7, 7, 9, 9, 9, 7, 7, 3]);
}

#[test]
fn shapes_partly_and_wholly_outside() {
    let mut l = Layer::new(4, 4);
    l.rect(-2, -2, 4, 4, C, true);
    assert_eq!(lit(&l).len(), 4);
    l.fill(0);
    l.rect(10, 10, 4, 4, C, true);
    l.circle(-20, 2, 5, C, true);
    l.line(-9, -9, -1, -1, C);
    l.pixel(-1, 0, C);
    l.pixel(4, 0, C);
    assert!(lit(&l).is_empty());
}

#[test]
fn coordinates_near_the_i32_limits_terminate_and_give_the_expected_pixels() {
    let mut l = Layer::new(8, 8);
    l.line(i32::MIN, i32::MIN, i32::MAX, i32::MAX, C);
    assert_eq!(lit(&l), (0..8).map(|i| (i, i)).collect::<Vec<_>>());
    let mut l = Layer::new(8, 8);
    l.line(i32::MAX, 3, i32::MIN, 3, C);
    assert_eq!(lit(&l).len(), 8);
    l.fill(0);
    l.line(i32::MIN, 0, i32::MAX, 1, C);
    assert_eq!(lit(&l).len(), 8);
    l.fill(0);
    l.line(0, i32::MIN, 1, i32::MAX, C);
    assert_eq!(lit(&l).len(), 8);
    l.fill(0);
    l.rect(i32::MAX - 1, i32::MAX - 1, i32::MAX, i32::MAX, C, true);
    l.rect(i32::MIN, i32::MIN, i32::MAX, i32::MAX, C, false);
    l.rect(-3, -3, i32::MAX, i32::MAX, C, true);
    assert_eq!(lit(&l).len(), 64);
    l.fill(0);
    l.circle(i32::MAX, i32::MAX, i32::MAX, C, true);
    l.circle(i32::MIN, 0, i32::MAX, C, false);
    l.circle(0, 0, i32::MAX, C, false);
    assert!(lit(&l).is_empty());
    l.circle(i32::MIN, 0, i32::MAX, C, true);
    assert!(lit(&l).is_empty(), "the disc ends left of column 0");
    l.circle(0, 0, i32::MAX, C, true);
    assert_eq!(lit(&l).len(), 64);
}
