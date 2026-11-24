import { SimulatorError } from "./errors.ts";

export interface Glyph {
  /** DWIDTH x. */
  advance: number;
  bbxW: number;
  bbxH: number;
  bbxX: number;
  bbxY: number;
  /** One byte array per row, most significant bit first. */
  rows: Uint8Array[];
}

export interface Font {
  /** FONTBOUNDINGBOX width: the advance of a missing glyph. */
  cellWidth: number;
  /** FONTBOUNDINGBOX height: the cell height. */
  cellHeight: number;
  ascent: number;
  glyphs: ReadonlyMap<number, Glyph>;
}

/** Parses a BDF file (ENCODING, DWIDTH, BBX, BITMAP, FONT_ASCENT, FONTBOUNDINGBOX); the engine holds no font data. */
export function parseFont(bdf: string): Font {
  const glyphs = new Map<number, Glyph>();
  let cell: [number, number] | undefined;
  let ascent: number | undefined;
  let encoding = -1;
  let advance = 0;
  let bbx: number[] = [0, 0, 0, 0];
  let rows: Uint8Array[] | undefined;
  for (const raw of bdf.split(/\r?\n/)) {
    const line = raw.trim();
    if (rows) {
      if (line === "ENDCHAR") {
        if (encoding >= 0) {
          glyphs.set(encoding, { advance, bbxW: bbx[0] as number, bbxH: bbx[1] as number, bbxX: bbx[2] as number, bbxY: bbx[3] as number, rows });
        }
        rows = undefined;
      } else if (line !== "") {
        const row = new Uint8Array(line.length / 2);
        for (let i = 0; i < row.length; i++) row[i] = Number.parseInt(line.slice(i * 2, i * 2 + 2), 16);
        rows.push(row);
      }
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const nums = rest.map(Number);
    if (key === "FONTBOUNDINGBOX") cell = [nums[0] as number, nums[1] as number];
    else if (key === "FONT_ASCENT") ascent = nums[0];
    else if (key === "STARTCHAR") encoding = -1;
    else if (key === "ENCODING") encoding = nums[0] as number;
    else if (key === "DWIDTH") advance = nums[0] as number;
    else if (key === "BBX") bbx = nums;
    else if (key === "BITMAP") rows = [];
  }
  if (!cell || ascent === undefined || Number.isNaN(ascent))
    throw new SimulatorError("font: the BDF has no FONTBOUNDINGBOX or FONT_ASCENT", { rule: "font" });
  return { cellWidth: cell[0], cellHeight: cell[1], ascent, glyphs };
}
