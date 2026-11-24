// A tiny WebAssembly assembler for tests: modules as bytes, no WAT toolchain (spec 115 AC-13).
const leb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const str = (s: string): number[] => [...leb(s.length), ...new TextEncoder().encode(s)];
const vec = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];

const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d } as const;
type V = keyof typeof T;
interface FnSig {
  params: V[];
  results: V[];
}
export interface Spec {
  /** Imports: [name, sig]; module is `panelator` unless `module` is given. */
  imports?: { module?: string; name: string; sig: FnSig }[];
  funcs: { sig: FnSig; body: number[]; export?: string }[];
  memory?: { min: number; max?: number } | null;
  /** More memories (for the "more than one memory" case). */
  extraMemory?: boolean;
  memoryExport?: string | null;
  start?: number;
  data?: { offset: number; bytes: number[] }[];
}

/** Body helpers: instruction bytes. */
export const op = {
  i32const: (n: number): number[] => [0x41, ...sleb(n)],
  i64const: (n: number): number[] => [0x42, ...sleb(n)],
  call: (i: number): number[] => [0x10, ...leb(i)],
  drop: [0x1a],
  localGet: (i: number): number[] => [0x20, ...leb(i)],
  i32store: [0x36, 2, 0],
  i32load: [0x28, 2, 0],
  memoryGrow: [0x40, 0],
  unreachable: [0x00],
};

export function assemble(spec: Spec): Uint8Array {
  const types: FnSig[] = [];
  const typeIdx = (s: FnSig): number => {
    const key = JSON.stringify(s);
    let i = types.findIndex((t) => JSON.stringify(t) === key);
    if (i < 0) i = types.push(s) - 1;
    return i;
  };
  const imports = spec.imports ?? [];
  const importTypes = imports.map((i) => typeIdx(i.sig));
  const funcTypes = spec.funcs.map((f) => typeIdx(f.sig));
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  out.push(
    ...section(
      1,
      vec(types.map((t) => [0x60, ...vec(t.params.map((p) => [T[p]])), ...vec(t.results.map((p) => [T[p]]))])),
    ),
  );
  if (imports.length) {
    out.push(
      ...section(
        2,
        vec(
          imports.map((i, k) => [...str(i.module ?? "panelator"), ...str(i.name), 0, ...leb(importTypes[k] as number)]),
        ),
      ),
    );
  }
  out.push(...section(3, vec(funcTypes.map((t) => leb(t)))));
  const memories: number[][] = [];
  if (spec.memory !== null) {
    const m = spec.memory ?? { min: 1, max: 4 };
    memories.push(m.max === undefined ? [0, ...leb(m.min)] : [1, ...leb(m.min), ...leb(m.max)]);
    if (spec.extraMemory) memories.push([0, 1]);
  }
  if (memories.length) out.push(...section(5, vec(memories)));
  const exportsList: number[][] = [];
  spec.funcs.forEach((f, i) => {
    if (f.export) exportsList.push([...str(f.export), 0, ...leb(imports.length + i)]);
  });
  const memName = spec.memoryExport === undefined ? "memory" : spec.memoryExport;
  if (memName && memories.length) exportsList.push([...str(memName), 2, 0]);
  out.push(...section(7, vec(exportsList)));
  if (spec.start !== undefined) out.push(...section(8, leb(spec.start)));
  out.push(
    ...section(
      10,
      vec(
        spec.funcs.map((f) => {
          const body = [0, ...f.body, 0x0b];
          return [...leb(body.length), ...body];
        }),
      ),
    ),
  );
  if (spec.data?.length) {
    out.push(
      ...section(11, vec(spec.data.map((d) => [0, ...op.i32const(d.offset), 0x0b, ...vec(d.bytes.map((b) => [b]))]))),
    );
  }
  return new Uint8Array(out);
}

const I = "i32" as const;
/** The four declarations plus pn_init/pn_update, with the given bodies, to be spread into `funcs`. */
export function declarations(
  d: { abi?: number; hz?: number; w?: number; h?: number; init?: number[]; update?: number[] } = {},
): Spec["funcs"] {
  const c = (n: number): number[] => op.i32const(n);
  return [
    { sig: { params: [], results: [I] }, body: c(d.abi ?? 1), export: "pn_abi_version" },
    { sig: { params: [], results: [I] }, body: c(d.hz ?? 60), export: "pn_update_hz" },
    { sig: { params: [], results: [I] }, body: c(d.w ?? 8), export: "pn_width" },
    { sig: { params: [], results: [I] }, body: c(d.h ?? 8), export: "pn_height" },
    { sig: { params: [], results: [] }, body: d.init ?? [], export: "pn_init" },
    { sig: { params: ["i64"], results: [] }, body: d.update ?? [], export: "pn_update" },
  ];
}

/** A function type for an import of the ABI by its i32 parameter count and result. */
export const imp = (name: string, params: number, result?: V, last?: V[]): NonNullable<Spec["imports"]>[number] => ({
  name,
  sig: { params: [...Array<V>(params).fill(I), ...(last ?? [])], results: result ? [result] : [] },
});
