import type { Font } from "./font.ts";
import { MALFORMED } from "./utf8.ts";

// The drawing rules of docs/widget-abi.md "The layer and the drawing rules". Every function sets exactly the pixels the
// document's pseudo-code gives, clipped analytically so that a call's cost is bounded by the layer, not by its arguments.
// Coordinates are i32 and so exact doubles; the few products that can leave 2^53 are done in BigInt.

export class Layer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** Sets the pixel when it is inside; `color` is `0xRRGGBBAA` in an i32. */
  pixel(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const u = color >>> 0;
    const o = (y * this.width + x) * 4;
    this.data[o] = u >>> 24;
    this.data[o + 1] = (u >>> 16) & 255;
    this.data[o + 2] = (u >>> 8) & 255;
    this.data[o + 3] = u & 255;
  }

  rgba(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.data[o] = r;
    this.data[o + 1] = g;
    this.data[o + 2] = b;
    this.data[o + 3] = a;
  }

  /** Sets the pixels of row `y` from `x0` to `x1`, both included, that are inside. */
  span(y: number, x0: number, x1: number, color: number): void {
    if (y < 0 || y >= this.height) return;
    const lo = Math.max(x0, 0);
    const hi = Math.min(x1, this.width - 1);
    for (let x = lo; x <= hi; x++) this.pixel(x, y, color);
  }

  fill(color: number): void {
    for (let y = 0; y < this.height; y++) this.span(y, 0, this.width - 1, color);
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const d = Math.max(dx, dy);
    if (d === 0) {
      this.pixel(x0, y0, color);
      return;
    }
    const m = Math.min(dx, dy);
    const xMajor = dx >= dy;
    const a0 = xMajor ? x0 : y0;
    const b0 = xMajor ? y0 : x0;
    const sMajor = (xMajor ? x1 > x0 : y1 > y0) ? 1 : -1;
    const sMinor = (xMajor ? y1 >= y0 : x1 >= x0) ? 1 : -1;
    const extent = xMajor ? this.width : this.height;
    const lo = sMajor > 0 ? Math.max(0, -a0) : Math.max(0, a0 - extent + 1);
    const hi = sMajor > 0 ? Math.min(d, extent - 1 - a0) : Math.min(d, a0);
    for (let i = lo; i <= hi; i++) {
      const b = b0 + sMinor * minorOffset(i, m, d);
      const a = a0 + sMajor * i;
      if (xMajor) this.pixel(a, b, color);
      else this.pixel(b, a, color);
    }
  }

  rect(x: number, y: number, w: number, h: number, color: number, filled: boolean): void {
    if (w <= 0 || h <= 0) return;
    const bottom = y + h - 1;
    const right = x + w - 1;
    const lo = Math.max(y, 0);
    const hi = Math.min(bottom, this.height - 1);
    for (let j = lo; j <= hi; j++) {
      if (filled || j === y || j === bottom) this.span(j, x, right, color);
      else {
        this.pixel(x, j, color);
        this.pixel(right, j, color);
      }
    }
  }

  circle(cx: number, cy: number, r: number, color: number, filled: boolean): void {
    if (r < 0) return;
    if (r === 0) {
      this.pixel(cx, cy, color);
      return;
    }
    const { width: W, height: H } = this;
    const r2 = BigInt(r) * BigInt(r);
    // Row y of the midpoint loop has x = X(y): the least z >= 0 with z (z + 1) >= r^2 - y^2.
    const X = (y: number): number => {
      const rem = r2 - BigInt(y) * BigInt(y);
      return rem <= 0n ? 0 : Number(ceilSqrt(4n * rem + 1n) / 2n);
    };
    let lo = 0;
    let hi = r;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (X(mid) >= mid) lo = mid;
      else hi = mid - 1;
    }
    const yEnd = lo;
    const row = (py: number, h: number): void => {
      if (filled) this.span(py, cx - h, cx + h, color);
      else {
        this.pixel(cx - h, py, color);
        this.pixel(cx + h, py, color);
      }
    };
    // Rows cy +- y at half-width x.
    for (let y = Math.max(0, -cy); y <= Math.min(yEnd, H - 1 - cy); y++) row(cy + y, X(y));
    for (let y = Math.max(0, cy - H + 1); y <= Math.min(yEnd, cy); y++) row(cy - y, X(y));
    // Rows cy +- x at half-width y: for a row offset k, the y with X(y) = k are r^2-k^2-k <= y^2 < r^2-k^2+k.
    const swapped = (py: number, k: number): void => {
      if (k < 1) return;
      const kk = BigInt(k);
      const loSq = r2 - kk * kk - kk;
      const hiSq = r2 - kk * kk + kk;
      if (hiSq <= 0n) return;
      const ylo = Math.max(0, loSq <= 0n ? 0 : Number(ceilSqrt(loSq)));
      const yhi = Math.min(yEnd, Number(ceilSqrt(hiSq)) - 1);
      if (ylo > yhi) return;
      if (filled) {
        this.span(py, cx - yhi, cx + yhi, color);
        return;
      }
      for (let y = Math.max(ylo, cx - W + 1); y <= Math.min(yhi, cx); y++) this.pixel(cx - y, py, color);
      for (let y = Math.max(ylo, -cx); y <= Math.min(yhi, W - 1 - cx); y++) this.pixel(cx + y, py, color);
    };
    for (let k = Math.max(0, -cy); k <= Math.min(r, H - 1 - cy); k++) swapped(cy + k, k);
    for (let k = Math.max(0, cy - H + 1); k <= Math.min(r, cy); k++) swapped(cy - k, k);
  }

  /** Draws the code points as `drawText` of the document; returns the advance. */
  text(font: Font, x: number, y: number, codePoints: readonly number[], color: number, draw: boolean): number {
    let pen = x;
    for (const cp of codePoints) {
      const g = cp === MALFORMED ? undefined : font.glyphs.get(cp);
      if (!g) {
        pen += font.cellWidth;
        continue;
      }
      if (draw) {
        const top = y + (font.ascent - g.bbxY - g.bbxH);
        for (let j = 0; j < g.rows.length; j++) {
          const bits = g.rows[j] as Uint8Array;
          for (let c = 0; c < g.bbxW; c++) {
            if ((((bits[c >> 3] as number) >> (7 - (c & 7))) & 1) !== 0) this.pixel(pen + g.bbxX + c, top + j, color);
          }
        }
      }
      pen += g.advance;
    }
    return pen - x;
  }

  /** Blits one frame of RGB (3 bytes a pixel) with alpha 255 at (x, y), clipped. */
  image(rgb: Uint8Array, offset: number, w: number, h: number, x: number, y: number): void {
    const x0 = Math.max(0, -x);
    const x1 = Math.min(w - 1, this.width - 1 - x);
    for (let j = Math.max(0, -y); j <= Math.min(h - 1, this.height - 1 - y); j++) {
      for (let i = x0; i <= x1; i++) {
        const o = offset + (j * w + i) * 3;
        this.rgba(x + i, y + j, rgb[o] as number, rgb[o + 1] as number, rgb[o + 2] as number, 255);
      }
    }
  }
}

/** The steps along the minor axis at step i: floor((2 i m + d) / (2 d)), exact. */
function minorOffset(i: number, m: number, d: number): number {
  const num = 2 * i * m + d;
  const den = 2 * d;
  if (num <= Number.MAX_SAFE_INTEGER) return (num - (num % den)) / den;
  return Number((2n * BigInt(i) * BigInt(m) + BigInt(d)) / (2n * BigInt(d)));
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/** The least y with y * y >= n. */
function ceilSqrt(n: bigint): bigint {
  const s = isqrt(n);
  return s * s === n ? s : s + 1n;
}
