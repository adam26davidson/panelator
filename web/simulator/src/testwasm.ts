import { IMPORT_TABLE, type Signature } from "./abi.ts";

// A test helper: small widget modules assembled as bytes (no WAT toolchain). Every module imports the sixteen functions
// of the table in the table's order, so import `n` is function `n`.
const CODE = { i32: 0x7f, i64: 0x7e, f32: 0x7d } as const;
type Ty = keyof typeof CODE;

export const uleb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};
export const sleb = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const str = (s: string): number[] => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

export const NAMES = Object.keys(IMPORT_TABLE);
export const i32c = (n: number): number[] => [0x41, ...sleb(n | 0)];
export const i64c = (n: number): number[] => [0x42, ...sleb(n)];
/** A call of an import by name with i32 constants; the result, if any, stays on the stack. */
export const callv = (name: string, ...args: number[]): number[] => [...args.flatMap(i32c), 0x10, ...uleb(NAMES.indexOf(name))];
/** A call whose result, if any, is dropped. */
export const call = (name: string, ...args: number[]): number[] => [
  ...callv(name, ...args),
  ...((IMPORT_TABLE[name] as Signature).results.length > 0 ? [0x1a] : []),
];
/** Writes `expr` (an i32 on the stack) as the colour of pixel (slot, 0): its low 24 bits show in the frame. */
export const emit = (slot: number, expr: number[]): number[] => [
  ...i32c(slot),
  ...i32c(0),
  ...expr,
  ...i32c(8),
  0x74, // i32.shl
  ...i32c(255),
  0x72, // i32.or
  0x10,
  ...uleb(NAMES.indexOf("draw_pixel")),
];
export const ld8 = (addr: number): number[] => [...i32c(addr), 0x2d, 0, 0];
/** A memory.grow of n pages, dropped. */
export const grow = (pages: number): number[] => [...i32c(pages), 0x40, 0, 0x1a];

export interface ModuleSpec {
  imports?: { module?: string; name: string; params: Ty[]; results: Ty[] }[];
  version?: number;
  hz?: number;
  width?: number;
  height?: number;
  init?: number[];
  update?: number[];
  /** Linear memories (default one of 1 page, no maximum); `[]` for none. */
  memories?: { min: number; max?: number }[];
  exportMemory?: boolean;
  start?: number;
  omit?: string[];
  extraExport?: string;
  sigOverride?: Record<string, { params: Ty[]; results: Ty[] }>;
  data?: { offset: number; bytes: number[] }[];
}

export function assemble(spec: ModuleSpec = {}): Uint8Array {
  const imports: NonNullable<ModuleSpec["imports"]> =
    spec.imports ??
    NAMES.map((name) => {
      const s = IMPORT_TABLE[name] as Signature;
      return { name, params: [...s.params] as Ty[], results: [...s.results] as Ty[] };
    });
  const fns: { name: string; params: Ty[]; results: Ty[]; body: number[] }[] = [
    { name: "pn_abi_version", params: [], results: ["i32"], body: i32c(spec.version ?? 1) },
    { name: "pn_update_hz", params: [], results: ["i32"], body: i32c(spec.hz ?? 60) },
    { name: "pn_width", params: [], results: ["i32"], body: i32c(spec.width ?? 8) },
    { name: "pn_height", params: [], results: ["i32"], body: i32c(spec.height ?? 8) },
    { name: "pn_init", params: [], results: [], body: spec.init ?? [] },
    { name: "pn_update", params: ["i64"], results: [], body: spec.update ?? [] },
  ];
  for (const f of fns) {
    const o = spec.sigOverride?.[f.name];
    if (o) {
      f.params = o.params;
      f.results = o.results;
      f.body = o.results.length > 0 ? i32c(0) : [];
      if (o.results[0] === "i64") f.body = i64c(0);
    }
  }
  const type = (p: Ty[], r: Ty[]): number[] => [0x60, ...vec(p.map((t) => [CODE[t]])), ...vec(r.map((t) => [CODE[t]]))];
  const types = [...imports.map((i) => type(i.params, i.results)), ...fns.map((f) => type(f.params, f.results))];
  const memories = spec.memories ?? [{ min: 1 }];
  const out: number[] = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  out.push(...section(1, vec(types)));
  out.push(...section(2, vec(imports.map((im, i) => [...str(im.module ?? "panelator"), ...str(im.name), 0, ...uleb(i)]))));
  out.push(...section(3, vec(fns.map((_, i) => uleb(imports.length + i)))));
  if (memories.length > 0)
    out.push(...section(5, vec(memories.map((m) => (m.max === undefined ? [0, ...uleb(m.min)] : [1, ...uleb(m.min), ...uleb(m.max)])))));
  const exports: number[][] = [];
  if (spec.exportMemory !== false && memories.length > 0) exports.push([...str("memory"), 2, 0]);
  fns.forEach((f, i) => {
    if (!spec.omit?.includes(f.name)) exports.push([...str(f.name), 0, ...uleb(imports.length + i)]);
  });
  if (spec.extraExport) exports.push([...str(spec.extraExport), 0, ...uleb(imports.length)]);
  out.push(...section(7, vec(exports)));
  if (spec.start !== undefined) out.push(...section(8, uleb(spec.start)));
  out.push(...section(10, vec(fns.map((f) => { const b = [0, ...f.body, 0x0b]; return [...uleb(b.length), ...b]; }))));
  if (spec.data) out.push(...section(11, vec(spec.data.map((d) => [0, ...i32c(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes]))));
  return Uint8Array.from(out);
}
