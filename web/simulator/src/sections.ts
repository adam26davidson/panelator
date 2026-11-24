import type { ValType } from "./abi.ts";
import { SimulatorError } from "./errors.ts";

// A reader of the sections of a module that the browser's WebAssembly API does not report: signatures, the limits of
// the memory and the start function (spec 115 AC-3). The browser has already compiled the module, so it is well formed.
export interface FuncType {
  params: number[];
  results: number[];
}
export interface Limits {
  min: number;
  max: number | undefined;
}
export interface ImportEntry {
  module: string;
  name: string;
  kind: number;
  type?: number;
}
export interface ExportEntry {
  name: string;
  kind: number;
  index: number;
}
export interface Sections {
  types: FuncType[];
  imports: ImportEntry[];
  functions: number[];
  memories: Limits[];
  importedMemories: number;
  exports: ExportEntry[];
  start: number | undefined;
}

const VAL_TYPES: Record<number, ValType> = { 0x7f: "i32", 0x7e: "i64" };
export const valTypeName = (code: number): string =>
  VAL_TYPES[code] ?? ({ 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" }[code] ?? `0x${code.toString(16)}`);

class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  byte(): number {
    const b = this.bytes[this.pos++];
    if (b === undefined) throw new SimulatorError("module is truncated", { rule: "module form" });
    return b;
  }
  u32(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
  }
  name(): string {
    const len = this.u32();
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    let text = "";
    for (const b of slice) text += String.fromCharCode(b); // names the engine accepts are ASCII; others never match
    return text;
  }
  limits(): Limits {
    const flag = this.byte();
    const min = this.u32();
    return { min, max: flag & 1 ? this.u32() : undefined };
  }
}

export function readSections(bytes: Uint8Array): Sections {
  const out: Sections = {
    types: [],
    imports: [],
    functions: [],
    memories: [],
    importedMemories: 0,
    exports: [],
    start: undefined,
  };
  const r = new Reader(bytes);
  r.pos = 8; // magic and version
  while (r.pos < bytes.length) {
    const id = r.byte();
    const size = r.u32();
    const end = r.pos + size;
    switch (id) {
      case 1: {
        for (let n = r.u32(); n > 0; n--) {
          if (r.byte() !== 0x60) throw new SimulatorError("unknown type form", { rule: "module form" });
          const params: number[] = [];
          for (let p = r.u32(); p > 0; p--) params.push(r.byte());
          const results: number[] = [];
          for (let p = r.u32(); p > 0; p--) results.push(r.byte());
          out.types.push({ params, results });
        }
        break;
      }
      case 2: {
        for (let n = r.u32(); n > 0; n--) {
          const module = r.name();
          const name = r.name();
          const kind = r.byte();
          const entry: ImportEntry = { module, name, kind };
          if (kind === 0) entry.type = r.u32();
          else if (kind === 1) {
            r.byte();
            r.limits();
          } else if (kind === 2) {
            r.limits();
            out.importedMemories++;
          } else if (kind === 3) {
            r.byte();
            r.byte();
          } else r.pos = end;
          out.imports.push(entry);
        }
        break;
      }
      case 3:
        for (let n = r.u32(); n > 0; n--) out.functions.push(r.u32());
        break;
      case 5:
        for (let n = r.u32(); n > 0; n--) out.memories.push(r.limits());
        break;
      case 7:
        for (let n = r.u32(); n > 0; n--) {
          const name = r.name();
          const kind = r.byte();
          out.exports.push({ name, kind, index: r.u32() });
        }
        break;
      case 8:
        out.start = r.u32();
        break;
      default:
    }
    r.pos = end;
  }
  return out;
}
