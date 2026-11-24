// The ABI of docs/widget-abi.md as data: the import table and the exports. One place; a test compares it with the document.
export type ValType = "i32" | "i64";
export interface Signature {
  params: ValType[];
  result: ValType | null;
  /** More than one result (never valid in this ABI). */
  multi?: boolean;
}

const I = "i32" as const;
const sig = (n: number, result: ValType | null = null, last: ValType[] = []): Signature => ({
  params: [...Array<ValType>(n).fill(I), ...last],
  result,
});

export const IMPORT_MODULE = "panelator";

export const IMPORTS: Record<string, Signature> = {
  layer_width: sig(0, I),
  layer_height: sig(0, I),
  draw_fill: sig(1),
  draw_pixel: sig(3),
  draw_line: sig(5),
  draw_rect: sig(6),
  draw_circle: sig(5),
  draw_text: sig(6, I),
  text_width: sig(3, I),
  font_height: sig(1, I),
  draw_image: sig(5, I),
  config_len: sig(0, I),
  config_read: sig(2, I),
  time_unix_ms: sig(0, "i64"),
  time_utc_offset_s: sig(0, I),
  random_u32: sig(0, I),
};

export const EXPORTS: Record<string, Signature> = {
  pn_abi_version: sig(0, I),
  pn_update_hz: sig(0, I),
  pn_width: sig(0, I),
  pn_height: sig(0, I),
  pn_init: sig(0),
  pn_update: { params: ["i64"], result: null },
};

export const sigText = (s: Signature): string =>
  `(${s.params.join(", ")})${s.multi ? " -> multiple results" : s.result ? ` -> ${s.result}` : ""}`;

export const sameSig = (a: Signature, b: Signature): boolean =>
  !a.multi && !b.multi && a.result === b.result && a.params.join() === b.params.join();

export const MAX_PAGES = 4;
export const PAGE = 65536;
