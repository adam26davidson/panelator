import { describe, expect, it } from "vitest";
import { circleLastStep, circleX, isqrt, Layer } from "./layer.ts";

const W = 24;
const H = 17;
const RED = 0xff0000ff | 0;

/** The set of pixels of a layer with any alpha set, as "x,y" strings. */
const set = (l: Layer): Set<string> => {
  const s = new Set<string>();
  for (let y = 0; y < l.height; y++)
    for (let x = 0; x < l.width; x++) if (l.data[(y * l.width + x) * 4 + 3]) s.add(`${x},${y}`);
  return s;
};
const ref = (pts: [number, number][]): Set<string> =>
  new Set(pts.filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => `${x},${y}`));

/** The document's Bresenham loop with BigInt, over the unclipped line (bounded inputs only). */
function refLine(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** The document's midpoint loop. */
function refCircle(cx: number, cy: number, r: number, filled: boolean): [number, number][] {
  if (r < 0) return [];
  if (r === 0) return [[cx, cy]];
  const out: [number, number][] = [];
  const row = (py: number, h: number): void => {
    if (filled) for (let px = cx - h; px <= cx + h; px++) out.push([px, py]);
    else out.push([cx - h, py], [cx + h, py]);
  };
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    row(cy + y, x);
    row(cy - y, x);
    row(cy + x, y);
    row(cy - x, y);
    y++;
    if (d < 0) d += 2 * y + 1;
    else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
  return out;
}

describe("lines", () => {
  it("equal the document's loop in all octants, horizontal, vertical and single-point", () => {
    for (const [x1, y1] of [
      [20, 3],
      [20, 9],
      [12, 14],
      [3, 16],
      [-5, 14],
      [-9, 5],
      [-4, -3],
      [10, -11],
      [7, 0],
      [0, 12],
      [0, 0],
      [1, 1],
      [-20, -20],
    ] as [number, number][]) {
      const l = new Layer(W, H);
      l.line(7, 6, 7 + x1, 6 + y1, RED);
      expect(set(l), `to ${x1},${y1}`).toEqual(ref(refLine(7, 6, 7 + x1, 6 + y1)));
    }
  });
  it("equal the loop for many pseudo-random endpoints, off the layer too", () => {
    let s = 12345;
    const rnd = (n: number): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return (s >>> 8) % n;
    };
    for (let i = 0; i < 400; i++) {
      const [a, b, c, d] = [rnd(80) - 30, rnd(60) - 20, rnd(80) - 30, rnd(60) - 20] as [number, number, number, number];
      const l = new Layer(W, H);
      l.line(a, b, c, d, RED);
      expect(set(l), `${a},${b} ${c},${d}`).toEqual(ref(refLine(a, b, c, d)));
    }
  });
  it("finish within the layer's size at the i32 limits", () => {
    const l = new Layer(W, H);
    l.line(-2147483648, -2147483648, 2147483647, 2147483647, RED);
    expect(l.writes).toBeLessThanOrEqual(Math.max(W, H));
    expect(set(l).size).toBeGreaterThan(0);
    l.line(-2147483648, 5, 2147483647, 6, RED);
    expect(l.writes).toBeLessThanOrEqual(W);
    l.line(2147483647, 2147483647, 2147483647, -2147483648, RED);
    expect(l.writes).toBe(0);
  });
});

describe("rectangles", () => {
  it("sizes 0, 1, 2 and larger in both modes", () => {
    for (const filled of [0, 1]) {
      const l = new Layer(W, H);
      l.rect(3, 3, 0, 5, RED, filled);
      l.rect(3, 3, 4, -1, RED, filled);
      expect(set(l).size).toBe(0);
      for (const [w, h] of [
        [1, 1],
        [1, 4],
        [2, 2],
        [2, 5],
        [3, 3],
        [6, 4],
      ] as const) {
        const m = new Layer(W, H);
        m.rect(3, 3, w, h, RED, filled);
        const want: [number, number][] = [];
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++)
            if (filled || i === 0 || j === 0 || i === w - 1 || j === h - 1) want.push([3 + i, 3 + j]);
        expect(set(m), `${w}x${h} filled=${filled}`).toEqual(ref(want));
      }
    }
  });
  it("clip at the edges, negative and at the i32 limits, in bounded work", () => {
    const l = new Layer(W, H);
    l.rect(-3, -3, 6, 6, RED, 1);
    expect(set(l).size).toBe(9);
    const m = new Layer(W, H);
    m.rect(-2147483648, -2147483648, 2147483647, 2147483647, RED, 0);
    expect(m.writes).toBeLessThanOrEqual(2 * (W + H));
    m.rect(2147483647, 2147483647, 2147483647, 5, RED, 1);
    expect(m.writes).toBe(0);
    m.rect(-5, -5, 2147483647, 2147483647, RED, 1);
    expect(m.writes).toBe(W * H);
  });
});

describe("circles", () => {
  it("the document's radius 3 and 4 examples", () => {
    const a = new Layer(W, H);
    a.circle(10, 8, 3, RED, 0);
    expect(set(a).size).toBe(16);
    const b = new Layer(W, H);
    b.circle(10, 8, 4, RED, 1);
    const rows = [0, 1, 2, 3, 4].map((j) => [...set(b)].filter((p) => p.endsWith(`,${8 + j}`)).length);
    expect(rows).toEqual([9, 9, 7, 7, 3]);
  });
  it("radius 0 to 8 in both modes equal the document's loop, wherever the centre", () => {
    for (let r = -1; r <= 8; r++)
      for (const filled of [false, true])
        for (const [cx, cy] of [
          [10, 8],
          [0, 0],
          [-3, 20],
          [23, 16],
          [-40, 5],
        ] as const) {
          const l = new Layer(W, H);
          l.circle(cx, cy, r, RED, filled ? 1 : 0);
          expect(set(l), `r=${r} filled=${filled} at ${cx},${cy}`).toEqual(ref(refCircle(cx, cy, r, filled)));
        }
  });
  it("larger radii equal the loop, including circles that cover the layer", () => {
    for (const r of [9, 13, 20, 27, 31, 50, 100, 257])
      for (const filled of [false, true])
        for (const [cx, cy] of [
          [12, 8],
          [3, 40],
          [-20, 8],
        ] as const) {
          const l = new Layer(W, H);
          l.circle(cx, cy, r, RED, filled ? 1 : 0);
          expect(set(l), `r=${r} filled=${filled} at ${cx},${cy}`).toEqual(ref(refCircle(cx, cy, r, filled)));
        }
  });
  it("finish in bounded work for huge radii and coordinates", () => {
    for (const filled of [0, 1]) {
      const l = new Layer(W, H);
      l.circle(12, 8, 2147483647, RED, filled);
      expect(l.writes).toBeLessThanOrEqual(2 * W * H);
      l.circle(-2147483648, 2147483647, 2147483647, RED, filled);
      expect(l.writes).toBeLessThanOrEqual(2 * W * H);
      l.circle(2147483647, 0, 2147483647, RED, filled);
      expect(l.writes).toBeLessThanOrEqual(2 * W * H);
    }
  });
  it("the closed form of the steps matches the loop", () => {
    for (let r = 1; r < 200; r++) {
      let x = r;
      let y = 0;
      let d = 1 - r;
      while (x >= y) {
        expect(circleX(r, y)).toBe(x);
        y++;
        if (d < 0) d += 2 * y + 1;
        else {
          x--;
          d += 2 * (y - x) + 1;
        }
      }
      expect(circleLastStep(r)).toBe(y - 1);
    }
    expect(isqrt(2n ** 64n)).toBe(2n ** 32n);
    expect(isqrt(2n ** 64n - 1n)).toBe(2n ** 32n - 1n);
  });
});

describe("fill and pixel", () => {
  it("set colour and alpha, and keep content between calls", () => {
    const l = new Layer(3, 2);
    expect([...l.data].every((b) => b === 0)).toBe(true);
    l.pixel(1, 1, 0x11223344);
    l.pixel(5, 5, RED);
    l.pixel(-1, 0, RED);
    expect([...l.data.slice(16, 20)]).toEqual([0x11, 0x22, 0x33, 0x44]);
    l.fill(0x01020304);
    expect([...l.data.slice(0, 4)]).toEqual([1, 2, 3, 4]);
  });
});
