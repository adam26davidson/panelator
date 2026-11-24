// A reader of the sections of a WebAssembly binary that the browser's API does not report: signatures, memory limits and
// the start function (spec 115 AC-3). Only what the engine needs; it validates nothing the browser already validated.
import type { Signature, ValType } from "./abi.ts";

export interface ModuleShape {
  /** Imports in order: the kind and, for a function, its signature. */
  imports: {
    module: string;
    name: string;
    kind: "function" | "table" | "memory" | "global" | "tag";
    sig?: Signature;
  }[];
  memories: { min: number; max: number | undefined }[];
  exports: { name: string; kind: "function" | "table" | "memory" | "global" | "tag"; index: number; sig?: Signature }[];
  start: number | undefined;
}

const VAL: Record<number, string> = { 127: "i32", 126: "i64", 125: "f32", 124: "f64" };
const KINDS = ["function", "table", "memory", "global", "tag"] as const;

class Reader {
  readonly b: Uint8Array;
  readonly end: number;
  pos: number;
  constructor(b: Uint8Array, pos: number, end: number) {
    this.b = b;
    this.pos = pos;
    this.end = end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new Error("unexpected end of section");
    return this.b[this.pos++] as number;
  }
  u(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const v = this.byte();
      result += (v & 0x7f) * scale;
      if ((v & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error("bad LEB128");
  }
  name(): string {
    const n = this.u();
    if (this.pos + n > this.end) throw new Error("name past the end");
    const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  limits(): { min: number; max: number | undefined } {
    const flag = this.byte();
    const min = this.u();
    return { min, max: flag & 1 ? this.u() : undefined };
  }
}

export function readShape(bytes: Uint8Array): ModuleShape {
  const types: Signature[] = [];
  const shape: ModuleShape = { imports: [], memories: [], exports: [], start: undefined };
  const functionTypes: number[] = [];
  let importedFunctions = 0;
  let pos = 8;
  while (pos < bytes.length) {
    const head = new Reader(bytes, pos + 1, bytes.length);
    const id = bytes[pos] as number;
    const size = head.u();
    const start = head.pos;
    const r = new Reader(bytes, start, start + size);
    pos = start + size;
    if (id === 1) {
      for (let n = r.u(); n > 0; n--) {
        if (r.byte() !== 0x60) throw new Error("not a function type");
        const params = Array.from({ length: r.u() }, () => VAL[r.byte()] as ValType);
        const results = Array.from({ length: r.u() }, () => VAL[r.byte()] as ValType);
        types.push({
          params,
          result: results.length === 1 ? (results[0] as ValType) : null,
          ...(results.length > 1 ? { multi: true } : {}),
        });
      }
    } else if (id === 2) {
      for (let n = r.u(); n > 0; n--) {
        const module = r.name();
        const name = r.name();
        const kind = KINDS[r.byte()] ?? "tag";
        if (kind === "function") {
          shape.imports.push({ module, name, kind, sig: types[r.u()] });
          importedFunctions++;
        } else {
          if (kind === "table") {
            r.byte();
            r.limits();
          } else if (kind === "memory") {
            const l = r.limits();
            shape.memories.push(l);
          } else if (kind === "global") {
            r.byte();
            r.byte();
          } else {
            r.byte();
            r.u();
          }
          shape.imports.push({ module, name, kind });
        }
      }
    } else if (id === 3) {
      for (let n = r.u(); n > 0; n--) functionTypes.push(r.u());
    } else if (id === 5) {
      for (let n = r.u(); n > 0; n--) shape.memories.push(r.limits());
    } else if (id === 7) {
      for (let n = r.u(); n > 0; n--) {
        const name = r.name();
        const kind = KINDS[r.byte()] ?? "tag";
        const index = r.u();
        let sigOf: Signature | undefined;
        if (kind === "function") {
          sigOf =
            index < importedFunctions
              ? shape.imports.filter((i) => i.kind === "function")[index]?.sig
              : types[functionTypes[index - importedFunctions] ?? -1];
        }
        shape.exports.push({ name, kind, index, ...(sigOf ? { sig: sigOf } : {}) });
      }
    } else if (id === 8) {
      shape.start = r.u();
    }
  }
  return shape;
}
