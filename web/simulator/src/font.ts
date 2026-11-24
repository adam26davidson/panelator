import type { Layer } from "./layer.ts";

export interface Glyph {
  /** DWIDTH x */
  advance: number;
  bbx: { w: number; h: number; x: number; y: number };
  /** One entry per bitmap row: the row's bytes. */
  rows: number[][];
}

export interface Font {
  /** FONTBOUNDINGBOX width and height: the advance of a missing glyph and the cell height. */
  boxWidth: number;
  cellHeight: number;
  ascent: number;
  glyphs: Map<number, Glyph>;
}

/** Parses a BDF file given as text (ENCODING, DWIDTH, BBX, BITMAP, FONT_ASCENT, FONTBOUNDINGBOX); holds no font data. */
export function parseFont(bdf: string): Font {
  const font: Font = { boxWidth: 0, cellHeight: 0, ascent: 0, glyphs: new Map() };
  let encoding = -1;
  let advance = 0;
  let bbx = { w: 0, h: 0, x: 0, y: 0 };
  let rows: number[][] | undefined;
  for (const raw of bdf.split("\n")) {
    const line = raw.trim();
    if (rows) {
      if (line === "ENDCHAR") {
        if (encoding >= 0) font.glyphs.set(encoding, { advance, bbx, rows });
        rows = undefined;
      } else if (line) {
        const bytes: number[] = [];
        for (let i = 0; i < line.length; i += 2) bytes.push(Number.parseInt(line.slice(i, i + 2), 16));
        rows.push(bytes);
      }
      continue;
    }
    const [key, ...v] = line.split(/\s+/);
    const n = v.map(Number);
    if (key === "FONTBOUNDINGBOX") [font.boxWidth, font.cellHeight] = n as [number, number];
    else if (key === "FONT_ASCENT") font.ascent = n[0] as number;
    else if (key === "STARTCHAR") {
      encoding = -1;
      advance = 0;
    } else if (key === "ENCODING") encoding = n[0] as number;
    else if (key === "DWIDTH") advance = n[0] as number;
    else if (key === "BBX") bbx = { w: n[0] as number, h: n[1] as number, x: n[2] as number, y: n[3] as number };
    else if (key === "BITMAP") rows = [];
  }
  return font;
}

/**
 * RFC 3629 decoding with each byte not part of a well-formed sequence counted alone. Returns code points, or -1 for a
 * malformed byte. (TextDecoder replaces by maximal subpart, which would give other advances.)
 */
export function decodeUtf8(b: Uint8Array): number[] {
  const out: number[] = [];
  const cont = (i: number, lo = 0x80, hi = 0xbf): boolean =>
    i < b.length && (b[i] as number) >= lo && (b[i] as number) <= hi;
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    let len = 1;
    let cp = -1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c <= 0xdf && cont(i + 1)) {
      len = 2;
      cp = ((c & 0x1f) << 6) | ((b[i + 1] as number) & 0x3f);
    } else if (c >= 0xe0 && c <= 0xef) {
      const lo = c === 0xe0 ? 0xa0 : 0x80;
      const hi = c === 0xed ? 0x9f : 0xbf;
      if (cont(i + 1, lo, hi) && cont(i + 2)) {
        len = 3;
        cp = ((c & 0x0f) << 12) | (((b[i + 1] as number) & 0x3f) << 6) | ((b[i + 2] as number) & 0x3f);
      }
    } else if (c >= 0xf0 && c <= 0xf4) {
      const lo = c === 0xf0 ? 0x90 : 0x80;
      const hi = c === 0xf4 ? 0x8f : 0xbf;
      if (cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3)) {
        len = 4;
        cp =
          ((c & 0x07) << 18) |
          (((b[i + 1] as number) & 0x3f) << 12) |
          (((b[i + 2] as number) & 0x3f) << 6) |
          ((b[i + 3] as number) & 0x3f);
      }
    }
    out.push(cp);
    i += len;
  }
  return out;
}

/** Draws `text` (UTF-8 bytes) with its first cell's top-left at (x, y) and returns the advance; `layer` may be omitted. */
export function drawText(
  font: Font,
  layer: Layer | undefined,
  x: number,
  y: number,
  text: Uint8Array,
  color: number,
): number {
  const [r, g, bl, a] = [color >>> 24, (color >>> 16) & 255, (color >>> 8) & 255, color & 255];
  let pen = x;
  for (const cp of decodeUtf8(text)) {
    const glyph = cp < 0 ? undefined : font.glyphs.get(cp);
    if (!glyph) {
      pen += font.boxWidth;
      continue;
    }
    if (layer) {
      const top = y + (font.ascent - glyph.bbx.y - glyph.bbx.h);
      for (let row = 0; row < glyph.bbx.h; row++) {
        const py = top + row;
        if (py < 0 || py >= layer.height) continue;
        const bytes = glyph.rows[row] ?? [];
        for (let col = 0; col < glyph.bbx.w; col++) {
          if (((bytes[col >> 3] ?? 0) >> (7 - (col & 7))) & 1) layer.setRGBA(pen + glyph.bbx.x + col, py, r, g, bl, a);
        }
      }
    }
    pen += glyph.advance;
  }
  return pen - x;
}
