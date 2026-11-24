// A placement's retained RGBA layer and the shape rules of docs/widget-abi.md "The layer and the drawing rules".
// Every coordinate is an i32 and every intermediate below stays an exact integer of a double (|value| < 2^53) unless it
// is a BigInt; every call is clipped analytically so its cost depends on the layer's size, not on its arguments.

export class Layer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Pixel writes made by the last call of a shape, for tests of the cost bound. */
  writes = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** Colour of an i32 argument as 0xRRGGBBAA. */
  static rgba(color: number): [number, number, number, number] {
    const c = color >>> 0;
    return [c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
  }

  setRGBA(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
    this.writes++;
  }

  fill(color: number): void {
    this.writes = 0;
    const [r, g, b, a] = Layer.rgba(color);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
    this.writes = this.width * this.height;
  }

  pixel(x: number, y: number, color: number): void {
    this.writes = 0;
    this.setRGBA(x, y, ...Layer.rgba(color));
  }

  private hspan(y: number, x0: number, x1: number, c: [number, number, number, number]): void {
    if (y < 0 || y >= this.height) return;
    for (let x = Math.max(x0, 0); x <= Math.min(x1, this.width - 1); x++) this.setRGBA(x, y, ...c);
  }

  private vspan(x: number, y0: number, y1: number, c: [number, number, number, number]): void {
    if (x < 0 || x >= this.width) return;
    for (let y = Math.max(y0, 0); y <= Math.min(y1, this.height - 1); y++) this.setRGBA(x, y, ...c);
  }

  /** Bresenham's line by its closed form: step i along the larger axis is (2 i m + d) / (2 d) along the smaller. */
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.writes = 0;
    const c = Layer.rgba(color);
    const adx = Math.abs(x1 - x0);
    const ady = Math.abs(y1 - y0);
    const xMajor = adx >= ady;
    const d = xMajor ? adx : ady;
    const m = xMajor ? ady : adx;
    const [p0, q0, p1, q1, pSize, qSize] = xMajor
      ? [x0, y0, x1, y1, this.width, this.height]
      : [y0, x0, y1, x1, this.height, this.width];
    const sp = p1 >= p0 ? 1 : -1;
    const sq = q1 >= q0 ? 1 : -1;
    // i in [0, d] with the major coordinate p0 + sp * i inside [0, pSize - 1]
    const lo = sp > 0 ? Math.max(0, -p0) : Math.max(0, p0 - (pSize - 1));
    const hi = sp > 0 ? Math.min(d, pSize - 1 - p0) : Math.min(d, p0);
    for (let i = lo; i <= hi; i++) {
      let step = 0;
      if (d > 0) {
        const num = 2 * i * m + d; // below 2^53 whenever it is a safe integer; else BigInt
        const den = 2 * d;
        step = Number.isSafeInteger(num)
          ? (num - (num % den)) / den
          : Number((2n * BigInt(i) * BigInt(m) + BigInt(d)) / BigInt(den));
      }
      const q = q0 + sq * step;
      if (q < 0 || q >= qSize) continue;
      const p = p0 + sp * i;
      if (xMajor) this.setRGBA(p, q, ...c);
      else this.setRGBA(q, p, ...c);
    }
  }

  rect(x: number, y: number, w: number, h: number, color: number, filled: number): void {
    this.writes = 0;
    if (w <= 0 || h <= 0) return;
    const c = Layer.rgba(color);
    const xe = x + w - 1;
    const ye = y + h - 1;
    if (filled !== 0) {
      for (let j = Math.max(y, 0); j <= Math.min(ye, this.height - 1); j++) this.hspan(j, x, xe, c);
      return;
    }
    this.hspan(y, x, xe, c);
    if (h > 1) this.hspan(ye, x, xe, c);
    this.vspan(x, y, ye, c);
    if (w > 1) this.vspan(xe, y, ye, c);
  }

  /** The integer midpoint circle, by rows: see circleX. */
  circle(cx: number, cy: number, r: number, color: number, filled: number): void {
    this.writes = 0;
    if (r < 0) return;
    const c = Layer.rgba(color);
    if (r === 0) {
      this.setRGBA(cx, cy, ...c);
      return;
    }
    const kMax = circleLastStep(r);
    // X is non-increasing in k, so the steps with x_k == m are one run, found by two binary searches.
    const atLeast = (m: number): number => bisect(0, kMax, (k) => circleX(r, k) >= m); // last k with x_k >= m
    const atMost = (m: number): number => bisect(0, kMax, (k) => circleX(r, k) > m) + 1; // first k with x_k <= m
    for (let py = Math.max(cy - r, 0); py <= Math.min(cy + r, this.height - 1); py++) {
      const m = Math.abs(py - cy);
      let half = -1; // filled: widest half-width on this row
      const edges: number[] = []; // outline: half-widths on this row
      if (m <= kMax) {
        const xk = circleX(r, m);
        half = xk;
        edges.push(xk);
      }
      if (m <= r) {
        const kHi = atLeast(m);
        const kLo = atMost(m);
        if (kLo <= kHi && circleX(r, kHi) >= m && circleX(r, kLo) <= m) {
          half = Math.max(half, kHi);
          if (filled === 0) {
            // only the steps whose two pixels fall inside the layer's columns matter
            const left = [Math.max(kLo, cx - (this.width - 1)), Math.min(kHi, cx)];
            const right = [Math.max(kLo, -cx), Math.min(kHi, this.width - 1 - cx)];
            for (let k = left[0] as number; k <= (left[1] as number); k++) this.setRGBA(cx - k, py, ...c);
            for (let k = right[0] as number; k <= (right[1] as number); k++) this.setRGBA(cx + k, py, ...c);
          }
        }
      }
      if (half < 0) continue;
      if (filled !== 0) this.hspan(py, cx - half, cx + half, c);
      else
        for (const e of edges) {
          this.setRGBA(cx - e, py, ...c);
          this.setRGBA(cx + e, py, ...c);
        }
    }
  }
}

/** Largest k in [lo, hi] with ok(k) true, ok being true on a prefix; lo - 1 when none. */
function bisect(lo: number, hi: number, ok: (k: number) => boolean): number {
  let a = lo - 1;
  let b = hi;
  while (a < b) {
    const mid = Math.ceil((a + b) / 2) + 0;
    if (ok(mid)) a = mid;
    else b = mid - 1;
  }
  return a;
}

/** floor(sqrt(n)) for 0 <= n, exact: Math.sqrt corrected by integer comparisons, BigInt above 2^52. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  if (n < 2n ** 52n) {
    let s = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (s * s > n) s--;
    while ((s + 1n) * (s + 1n) <= n) s++;
    return s;
  }
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * x of step k of the midpoint circle of radius r (0 <= k < r): the largest x with (x - 1/2)^2 + k^2 < r^2, that is
 * (2x - 1)^2 <= 4 r^2 - 4 k^2 - 1. Checked against the document's loop by the unit tests.
 */
export function circleX(r: number, k: number): number {
  const n = 4n * (BigInt(r) * BigInt(r) - BigInt(k) * BigInt(k)) - 1n;
  return Number((isqrt(n) + 1n) / 2n);
}

/** The last step k of the document's loop, the last with x_k >= k (k < r). */
export function circleLastStep(r: number): number {
  return bisect(0, r - 1, (k) => circleX(r, k) >= k);
}
