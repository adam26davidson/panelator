import { describe, expect, it } from "vitest";
import { Layer } from "./draw.ts";
import { bitmap, sceneOf, WHITE } from "./scenehelp.ts";
import { call } from "./testwasm.ts";

// References written from the document's pseudo-code, walking every pixel (no clipping tricks).
type Pts = Set<string>;
const key = (x: number, y: number) => `${x},${y}`;

function refLine(x0: number, y0: number, x1: number, y1: number): Pts {
  const out: Pts = new Set();
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.add(key(x, y));
    if (x === x1 && y === y1) return out;
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
}

function refRect(x: number, y: number, w: number, h: number, filled: boolean): Pts {
  const out: Pts = new Set();
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) if (filled || i === 0 || i === w - 1 || j === 0 || j === h - 1) out.add(key(x + i, y + j));
  return out;
}

function refCircle(cx: number, cy: number, r: number, filled: boolean): Pts {
  const out: Pts = new Set();
  if (r < 0) return out;
  if (r === 0) return out.add(key(cx, cy));
  const row = (py: number, h: number) => {
    if (filled) for (let px = cx - h; px <= cx + h; px++) out.add(key(px, py));
    else out.add(key(cx - h, py)).add(key(cx + h, py));
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

const W = 24;
const H = 17;
function drawn(f: (l: Layer) => void): Pts {
  const l = new Layer(W, H);
  f(l);
  const out: Pts = new Set();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (l.data[(y * W + x) * 4 + 3] !== 0) out.add(key(x, y));
  return out;
}
const clip = (p: Pts): Pts => new Set([...p].filter((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return x >= 0 && y >= 0 && x < W && y < H; }));
const same = (a: Pts, b: Pts) => expect([...a].sort()).toEqual([...b].sort());

let seed = 12345;
const rnd = (lo: number, hi: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return lo + (seed % (hi - lo + 1));
};

describe("lines (AC-4, AC-13)", () => {
  it("match the document's loop in all eight octants, horizontal, vertical and single-point", () => {
    const c = [12, 8];
    for (const [dx, dy] of [[9, 3], [3, 9], [-3, 9], [-9, 3], [-9, -3], [-3, -9], [3, -9], [9, -3], [7, 0], [0, 7], [-7, 0], [0, -7], [5, 5], [-5, 5], [0, 0]] as const) {
      const [x0, y0] = c as [number, number];
      same(drawn((l) => l.line(x0, y0, x0 + dx, y0 + dy, WHITE)), clip(refLine(x0, y0, x0 + dx, y0 + dy)));
    }
  });
  it("match the loop, clipped, for random lines partly and wholly outside", () => {
    for (let n = 0; n < 600; n++) {
      const [a, b, c, d] = [rnd(-40, 60), rnd(-40, 60), rnd(-40, 60), rnd(-40, 60)] as [number, number, number, number];
      same(drawn((l) => l.line(a, b, c, d, WHITE)), clip(refLine(a, b, c, d)));
    }
  });
});

describe("rectangles", () => {
  it("of sizes 0, 1, 2 and larger, in both modes, partly and wholly outside", () => {
    for (const w of [-1, 0, 1, 2, 3, 7])
      for (const h of [-1, 0, 1, 2, 3, 6])
        for (const filled of [true, false])
          for (const [x, y] of [[3, 4], [-2, -1], [20, 15], [-9, 3], [30, 30], [22, -3]] as const)
            same(drawn((l) => l.rect(x, y, w, h, WHITE, filled)), clip(refRect(x, y, w, h, filled)));
  });
});

describe("circles", () => {
  it("of radius 0 to 8 in both modes equal the document's loop", () => {
    for (let r = -1; r <= 8; r++)
      for (const filled of [true, false])
        for (const [cx, cy] of [[12, 8], [0, 0], [-3, 5], [23, 16], [40, 40]] as const)
          same(drawn((l) => l.circle(cx, cy, r, WHITE, filled)), clip(refCircle(cx, cy, r, filled)));
  });
  it("of radius 3 outlined is the 16 pixels of the document", () => {
    const got = drawn((l) => l.circle(12, 8, 3, WHITE, false));
    const want = [[3, 0], [3, 1], [3, -1], [-3, 0], [-3, 1], [-3, -1], [2, 2], [2, -2], [-2, 2], [-2, -2], [1, 3], [1, -3], [-1, 3], [-1, -3], [0, 3], [0, -3]].map(([x, y]) => key(12 + (x as number), 8 + (y as number)));
    expect(got.size).toBe(16);
    same(got, new Set(want));
  });
  it("of radius 4 filled has rows of 9, 9, 7, 7 and 3 pixels from the centre row outward", () => {
    const got = drawn((l) => l.circle(12, 8, 4, WHITE, true));
    const rowLen = (y: number) => [...got].filter((k) => k.endsWith(`,${y}`)).length;
    expect([0, 1, 2, 3, 4].map((o) => rowLen(8 + o))).toEqual([9, 9, 7, 7, 3]);
    expect([1, 2, 3, 4].map((o) => rowLen(8 - o))).toEqual([9, 7, 7, 3]);
  });
  it("of any radius, centred inside or outside the layer, equal the loop when clipped (analytic clipping)", () => {
    for (let n = 0; n < 60; n++) {
      const [cx, cy, r] = [rnd(-70, 90), rnd(-70, 90), rnd(0, 120)] as [number, number, number];
      for (const filled of [true, false]) same(drawn((l) => l.circle(cx, cy, r, WHITE, filled)), clip(refCircle(cx, cy, r, filled)));
    }
  });
});

describe("shapes at the limits of i32 (AC-4)", () => {
  const MIN = -2147483648;
  const MAX = 2147483647;
  it("finish at once and set what the document gives", async () => {
    const scene = await sceneOf({ width: 6, height: 6 }, [
      {
        width: 6,
        height: 6,
        spec: {
          init: [
            ...call("draw_line", MIN, MIN, MAX, MAX, WHITE),
            ...call("draw_rect", MIN, MIN, MAX, MAX, WHITE, 0),
            ...call("draw_circle", MAX, MAX, MAX, WHITE, 0),
            ...call("draw_circle", 0, 0, MAX, WHITE, 1),
            ...call("draw_line", MAX, 0, MIN, 0, WHITE),
          ],
        },
      },
    ]);
    // a filled circle of radius 2^31 - 1 centred at the origin covers the whole 6 by 6 layer
    expect(bitmap(scene).flat().every((v) => v === 1)).toBe(true);
  });
  it("a diagonal, a huge rectangle and a circle through the corner cost no more than the layer", () => {
    const t = performance.now();
    const l = new Layer(64, 64);
    l.line(-2147483648, -2147483648, 2147483647, 2147483647, WHITE);
    l.line(-2147483648, 5, 2147483647, 9, WHITE);
    l.rect(-2147483648, -2147483648, 2147483647, 2147483647, WHITE, true);
    l.circle(2147483647, 0, 2147483647, WHITE, false);
    l.circle(-2147483648, -2147483648, 2147483647, WHITE, true);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it("a huge circle outline's arc through the layer is the arc of the document's loop", () => {
    const l = new Layer(8, 8);
    l.circle(-1000, 4, 1003, WHITE, false);
    const got = new Set<string>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (l.data[(y * 8 + x) * 4 + 3]) got.add(key(x, y));
    const want = new Set([...refCircle(-1000, 4, 1003, false)].filter((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return x >= 0 && y >= 0 && x < 8 && y < 8; }));
    same(got, want);
  });
  it("fill and pixel set the colour, alpha included, and nothing is blended", () => {
    const l = new Layer(2, 1);
    l.pixel(0, 0, 0x11223344 | 0);
    l.pixel(0, 0, 0x55667788 | 0);
    expect([...l.data.subarray(0, 4)]).toEqual([0x55, 0x66, 0x77, 0x88]);
    l.fill(0x01020304);
    expect([...l.data]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });
});
