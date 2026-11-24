// The ABI 0.1 tables of docs/widget-abi.md ("Exports", "Imports"), written once.
export type ValType = "i32" | "i64";

export interface Signature {
  params: readonly ValType[];
  results: readonly ValType[];
}

const i32 = "i32" as const;
const i64 = "i64" as const;
const sig = (params: readonly ValType[], results: readonly ValType[] = []): Signature => ({ params, results });

export const IMPORT_MODULE = "panelator";

export const IMPORT_TABLE: Readonly<Record<string, Signature>> = {
  layer_width: sig([], [i32]),
  layer_height: sig([], [i32]),
  draw_fill: sig([i32]),
  draw_pixel: sig([i32, i32, i32]),
  draw_line: sig([i32, i32, i32, i32, i32]),
  draw_rect: sig([i32, i32, i32, i32, i32, i32]),
  draw_circle: sig([i32, i32, i32, i32, i32]),
  draw_text: sig([i32, i32, i32, i32, i32, i32], [i32]),
  text_width: sig([i32, i32, i32], [i32]),
  font_height: sig([i32], [i32]),
  draw_image: sig([i32, i32, i32, i32, i32], [i32]),
  config_len: sig([], [i32]),
  config_read: sig([i32, i32], [i32]),
  time_unix_ms: sig([], [i64]),
  time_utc_offset_s: sig([], [i32]),
  random_u32: sig([], [i32]),
};

export const EXPORT_TABLE: Readonly<Record<string, Signature>> = {
  pn_abi_version: sig([], [i32]),
  pn_update_hz: sig([], [i32]),
  pn_width: sig([], [i32]),
  pn_height: sig([], [i32]),
  pn_init: sig([]),
  pn_update: sig([i64]),
};

export const DECLARATIONS = ["pn_abi_version", "pn_update_hz", "pn_width", "pn_height"] as const;

export const ABI_MAJOR = 0;
export const ABI_MINOR = 1;
export const MAX_PAGES = 4;
export const PAGE_BYTES = 65536;
