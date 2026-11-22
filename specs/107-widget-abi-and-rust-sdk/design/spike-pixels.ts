// The pixel model behind the spike-widget design stories (spec 107 section 6). Not a story file.
//
// It follows the spec's drawing and composition rules (AC-6 to AC-8, AC-11) closely enough that a
// story's frame can be laid beside a golden frame: a draw call sets pixels, nothing blends inside a
// layer, composition is the integer formula of AC-11. The geometry and colour constants below are the
// design; flow.md lists the same values and the implementation takes them. Where this file and
// docs/widget-abi.md differ on a pixel (the circle's outline, say), the document wins.
//
// The glyph tables are a subset (the characters these stories draw) of Spleen 5x8 and Spleen 8x16,
// release 2.3.0, https://github.com/fcambus/spleen, each row of a glyph's BDF bitmap as two hex digits:
//
//   Copyright (c) 2018-2026, Frederic Cambus
//   All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
//   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS
//   BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//   SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//   CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//   ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.

/* ------------------------------------------------------------------ fonts */

export interface Font {
  id: number;
  name: string;
  /** Cell width (the advance of every glyph here) and cell height. */
  w: number;
  h: number;
  glyphs: Record<string, string>;
}

/** Font 1 of the ABI: Spleen 5x8. Digits ink rows 1 to 6 and columns 0 to 3 of the cell. */
export const FONT1: Font = {
  id: 1,
  name: "Spleen 5x8",
  w: 5,
  h: 8,
  glyphs: {
    "-": "00000000F0000000",
    "0": "006090B0D0906000",
    "1": "0020602020207000",
    "2": "006090106080F000",
    "3": "0060902010906000",
    "4": "0080A0A0F0202000",
    "5": "00F080E01010E000",
    "6": "006080E090906000",
    "7": "00F0901020404000",
    "8": "0060906090906000",
    "9": "0060909070106000",
  },
};

/** Font 2 of the ABI: Spleen 8x16. Digits ink rows 2 to 11 and columns 0 to 6 of the cell. */
export const FONT2: Font = {
  id: 2,
  name: "Spleen 8x16",
  w: 8,
  h: 16,
  glyphs: {
    " ": "00000000000000000000000000000000",
    "0": "00007CC6C6CEDEF6E6C6C67C00000000",
    "1": "00001838785818181818187E00000000",
    "2": "00007CC606060C183060C6FE00000000",
    "3": "00007CC606063C060606C67C00000000",
    "4": "0000C0C0CCCCCCCCFE0C0C0C00000000",
    "5": "0000FEC6C0C0FC060606C67C00000000",
    "6": "00007CC6C0C0FCC6C6C6C67C00000000",
    "7": "0000FEC606060C183030303000000000",
    "8": "00007CC6C6C67CC6C6C6C67C00000000",
    "9": "00007CC6C6C6C67E0606C67C00000000",
    ":": "00000000001818000000181800000000",
    H: "0000C6C6C6C6FEC6C6C6C6C600000000",
    a: "00000000007C067EC6C6C67E00000000",
    e: "00000000007EC6C6FEC0C07E00000000",
    l: "00003030303030303030301C00000000",
    n: "0000000000FCC6C6C6C6C6C600000000",
    o: "00000000007CC6C6C6C6C67C00000000",
    p: "0000000000FCC6C6C6C6C6FCC0C0C000",
    r: "00000000007EC6C0C0C0C0C000000000",
    t: "00003030307C30303030301E00000000",
    z: "0000000000FE060C183060FE00000000",
  },
};

/* ------------------------------------------------------------------ layers and draw calls */

/** A placement's layer: one 0xRRGGBBAA value per LED, all 0x00000000 at the start (AC-6). */
export interface Layer {
  w: number;
  h: number;
  px: Uint32Array;
}

export function newLayer(w: number, h: number): Layer {
  return { w, h, px: new Uint32Array(w * h) };
}

function set(l: Layer, x: number, y: number, color: number): void {
  if (x >= 0 && y >= 0 && x < l.w && y < l.h) l.px[y * l.w + x] = color >>> 0;
}

export function drawFill(l: Layer, color: number): void {
  l.px.fill(color >>> 0);
}

export function drawPixel(l: Layer, x: number, y: number, color: number): void {
  set(l, x, y, color);
}

/** Bresenham's line, both ends included. */
export function drawLine(l: Layer, x0: number, y0: number, x1: number, y1: number, color: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    set(l, x, y, color);
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
}

/** Filled: the w by h pixels from (x, y). Otherwise their one-pixel border. Nothing when w or h is 0 or less. */
export function drawRect(l: Layer, x: number, y: number, w: number, h: number, color: number, filled: boolean): void {
  if (w <= 0 || h <= 0) return;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      if (filled || j === 0 || j === h - 1 || i === 0 || i === w - 1) set(l, x + i, y + j, color);
}

/** The midpoint circle; filled also sets every pixel between the outline's ends on each row. */
export function drawCircle(l: Layer, cx: number, cy: number, r: number, color: number, filled: boolean): void {
  if (r < 0) return;
  const row = (y: number, half: number) => {
    if (filled) for (let x = cx - half; x <= cx + half; x++) set(l, x, y, color);
    else {
      set(l, cx - half, y, color);
      set(l, cx + half, y, color);
    }
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
}

/** Sets only the pixels the glyphs have set; (x, y) is the first cell's top-left. Returns the advance. */
export function drawText(l: Layer, font: Font, x: number, y: number, s: string, color: number): number {
  let pen = x;
  for (const ch of s) {
    const hex = font.glyphs[ch];
    if (hex)
      for (let j = 0; j < font.h; j++) {
        const bits = Number.parseInt(hex.slice(j * 2, j * 2 + 2), 16);
        for (let i = 0; i < font.w; i++) if (bits & (0x80 >> i)) set(l, pen + i, y + j, color);
      }
    pen += font.w;
  }
  return pen - x;
}

export function textWidth(font: Font, s: string): number {
  return [...s].length * font.w;
}

/** An asset frame: raw RGB, 3 bytes a pixel, rows top to bottom (AC-8). */
export interface Asset {
  w: number;
  h: number;
  rgb: Uint8Array;
}

/** Blits the asset with its top-left at (x, y), every pixel at alpha 255, clipped. */
export function drawImage(l: Layer, a: Asset, x: number, y: number): void {
  for (let j = 0; j < a.h; j++)
    for (let i = 0; i < a.w; i++) {
      const o = (j * a.w + i) * 3;
      set(l, x + i, y + j, ((a.rgb[o] << 24) | (a.rgb[o + 1] << 16) | (a.rgb[o + 2] << 8) | 0xff) >>> 0);
    }
}

/** assets/spike-image.rgb of AC-12: 128 by 64, R by x, G by y, B a checkerboard of 8-pixel squares. */
export function spikeImageAsset(): Asset {
  const w = 128;
  const h = 64;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      rgb[o] = Math.trunc((x * 255) / 127);
      rgb[o + 1] = Math.trunc((y * 255) / 63);
      rgb[o + 2] = (Math.trunc(x / 8) + Math.trunc(y / 8)) % 2 === 0 ? 255 : 0;
    }
  return { w, h, rgb };
}

/* ------------------------------------------------------------------ composition */

export interface Placed {
  layer: Layer;
  x: number;
  y: number;
  z: number;
  opacity: number;
}

/** A composed frame: RGB, 8 bits a channel, rows top to bottom. */
export interface Frame {
  w: number;
  h: number;
  rgb: Uint8Array;
}

/** AC-11: black frame, layers in ascending z (ties in list order), integer blend with layer opacity. */
export function compose(w: number, h: number, placements: Placed[]): Frame {
  const rgb = new Uint8Array(w * h * 3);
  const order = placements.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z || a.i - b.i);
  for (const { p } of order)
    for (let j = 0; j < p.layer.h; j++)
      for (let i = 0; i < p.layer.w; i++) {
        const x = p.x + i;
        const y = p.y + j;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const c = p.layer.px[j * p.layer.w + i];
        const a = Math.trunc(((c & 0xff) * p.opacity + 127) / 255);
        const o = (y * w + x) * 3;
        for (let k = 0; k < 3; k++) {
          const s = (c >>> (24 - 8 * k)) & 0xff;
          rgb[o + k] = Math.trunc((s * a + rgb[o + k] * (255 - a) + 127) / 255);
        }
      }
  return { w, h, rgb };
}

/** A layer alone on black: what each single-widget screen shows. */
export function onBlack(l: Layer): Frame {
  return compose(l.w, l.h, [{ layer: l, x: 0, y: 0, z: 0, opacity: 255 }]);
}

/* ------------------------------------------------------------------ the design: colours */

/** Every colour the three widgets use, as 0xRRGGBBAA. */
export const COLOR = {
  transparent: 0x00000000,
  black: 0x000000ff,
  white: 0xffffffff,
  amber: 0xffb000ff,
  green: 0x5cff8aff,
  cyan: 0x4fd8ffff,
  pink: 0xff7ab6ff,
  violet: 0xb9a1ffff,
  navy: 0x0b1f3aff,
  magenta: 0xff00ffff,
} as const;

export function hex(color: number): string {
  return `0x${(color >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/* ------------------------------------------------------------------ the design: spike-clock */

/** Geometry of spike-clock in layer pixels (declared size 64 by 32). */
export const CLOCK = {
  size: { w: 64, h: 32 },
  time: { font: FONT2, x: 0, y: 0, color: COLOR.white },
  separator: { x0: 0, y0: 14, x1: 63, y1: 14, color: COLOR.cyan },
  barOutline: { x: 1, y: 17, w: 62, h: 5, color: COLOR.cyan },
  /** The fill's width is the second, 0 to 59: nothing is drawn at second 0. */
  barFill: { x: 2, y: 18, h: 3, color: COLOR.amber },
  marks: { xs: [2, 17, 32, 47], y: 22, color: COLOR.white },
  date: { font: FONT1, x: 1, y: 24, color: COLOR.white },
  circle: { cx: 59, cy: 27, r: 3, color: COLOR.green },
  /** The plate: an opaque black rectangle under the separator, the seconds bar and the quarter marks. */
  plate: { x: 0, y: 13, w: 64, h: 11, color: COLOR.black },
  /** The disc: an opaque black filled circle, one pixel larger than the seconds circle, under it. */
  disc: { cx: 59, cy: 27, r: 4, color: COLOR.black },
  /**
   * The halo: before each text is drawn in white it is drawn four times in opaque black, moved by one
   * pixel left, right, up and down, so every edge of a glyph has a black pixel beside it on any background.
   */
  halo: {
    color: COLOR.black,
    offsets: [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ],
  },
} as const;

const two = (n: number) => String(n).padStart(2, "0");

/** Local time and date as the clock prints them. */
export function clockText(unixMs: number, utcOffsetS: number): { time: string; date: string; second: number } {
  const d = new Date(unixMs + utcOffsetS * 1000);
  return {
    time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`,
    date: `${String(d.getUTCFullYear()).padStart(4, "0")}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`,
    second: d.getUTCSeconds(),
  };
}

/** One update of spike-clock, in its draw order. */
export function updateClock(l: Layer, unixMs: number, utcOffsetS: number): void {
  const { time, date, second } = clockText(unixMs, utcOffsetS);
  const g = CLOCK;
  drawFill(l, COLOR.transparent);
  for (const [dx, dy] of g.halo.offsets) drawText(l, g.time.font, g.time.x + dx, g.time.y + dy, time, g.halo.color);
  drawText(l, g.time.font, g.time.x, g.time.y, time, g.time.color);
  drawRect(l, g.plate.x, g.plate.y, g.plate.w, g.plate.h, g.plate.color, true);
  drawLine(l, g.separator.x0, g.separator.y0, g.separator.x1, g.separator.y1, g.separator.color);
  drawRect(l, g.barOutline.x, g.barOutline.y, g.barOutline.w, g.barOutline.h, g.barOutline.color, false);
  drawRect(l, g.barFill.x, g.barFill.y, second, g.barFill.h, g.barFill.color, true);
  for (const x of g.marks.xs) drawPixel(l, x, g.marks.y, g.marks.color);
  for (const [dx, dy] of g.halo.offsets) drawText(l, g.date.font, g.date.x + dx, g.date.y + dy, date, g.halo.color);
  drawText(l, g.date.font, g.date.x, g.date.y, date, g.date.color);
  drawCircle(l, g.disc.cx, g.disc.cy, g.disc.r, g.disc.color, true);
  drawCircle(l, g.circle.cx, g.circle.cy, g.circle.r, g.circle.color, second % 2 === 0);
}

/* ------------------------------------------------------------------ the design: spike-scroll */

/** spike-scroll: the background and the six text colours, in the order of `random_u32() % 6`. */
export const SCROLL = {
  size: { w: 128, h: 16 },
  background: COLOR.navy,
  font: FONT2,
  y: 0,
  palette: [
    { name: "amber", color: COLOR.amber },
    { name: "white", color: COLOR.white },
    { name: "green", color: COLOR.green },
    { name: "cyan", color: COLOR.cyan },
    { name: "pink", color: COLOR.pink },
    { name: "violet", color: COLOR.violet },
  ],
} as const;

/** AC-11's xorshift32: the first `count` values for a seed. */
export function xorshift32(seed: number, count: number): number[] {
  let x = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out.push(x);
  }
  return out;
}

/** The palette index in effect at `tick`: one pick at pn_init, one more at each later tick where the text re-enters. */
export function scrollColorIndex(seed: number, tick: number, layerW: number, text: string): number {
  const period = layerW + textWidth(SCROLL.font, text);
  const picks = 1 + Math.trunc(tick / period);
  return xorshift32(seed, picks)[picks - 1] % SCROLL.palette.length;
}

export function scrollX(tick: number, layerW: number, text: string): number {
  return layerW - (tick % (layerW + textWidth(SCROLL.font, text)));
}

/** One update of spike-scroll. */
export function updateScroll(l: Layer, tick: number, text: string, colorIndex: number): void {
  drawFill(l, SCROLL.background);
  drawText(l, SCROLL.font, scrollX(tick, l.w, text), SCROLL.y, text, SCROLL.palette[colorIndex].color);
}

/* ------------------------------------------------------------------ the design: spike-image */

export const IMAGE = { size: { w: 128, h: 64 }, failure: COLOR.magenta } as const;

export function imageOffset(tick: number, layerW: number): number {
  return Math.trunc(tick / 2) % layerW;
}

/** One update of spike-image: two blits, at x = -o and x = W - o, so the image wraps. */
export function updateImage(l: Layer, tick: number, asset: Asset): void {
  const o = imageOffset(tick, l.w);
  drawImage(l, asset, -o, 0);
  drawImage(l, asset, l.w - o, 0);
}

/* ------------------------------------------------------------------ the scenes' clock */

/** The scenes of AC-17 start two seconds before midnight, 1 January 2027, at UTC+1. */
export const SCENE = { startUnixMs: 1798757998000, utcOffsetS: 3600 } as const;

export function sceneTimeMs(tick: number): number {
  return SCENE.startUnixMs + Math.trunc((tick * 1000) / 60);
}
