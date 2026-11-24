import { describe, expect, it } from "vitest";
import { assemble, declarations, imp, op } from "./assemble.ts";
import { loadModule } from "./module.ts";

const base = { funcs: declarations(), memory: { min: 1, max: 4 } };
const fails = async (bytes: Uint8Array, ...words: string[]): Promise<void> => {
  const err = await loadModule(bytes, "m").then(
    () => undefined,
    (e: Error) => e,
  );
  expect(err, `load of ${words.join(" ")} fails`).toBeInstanceOf(Error);
  for (const w of words) expect(err?.message).toContain(w);
};

describe("loadModule", () => {
  it("loads a conforming module and reports its four declarations", async () => {
    const m = await loadModule(assemble({ ...base, funcs: declarations({ hz: 30, w: 12, h: 5 }) }), "ok");
    expect([m.abi, m.updateHz, m.width, m.height, m.boundedMemory]).toEqual([{ major: 0, minor: 1 }, 30, 12, 5, true]);
  });
  it("refuses bytes that are not a module", async () => {
    await fails(new Uint8Array([1, 2, 3]), "not a module");
  });
  it("refuses an import outside the table, from another module, of another kind or with another signature", async () => {
    await fails(
      assemble({ ...base, imports: [imp("not_there", 0)] }),
      "import outside the import table",
      "panelator.not_there",
    );
    await fails(
      assemble({ ...base, imports: [{ module: "env", name: "draw_fill", sig: imp("x", 1).sig }] }),
      "env.draw_fill",
    );
    await fails(assemble({ ...base, imports: [imp("draw_fill", 2)] }), "import with another signature", "draw_fill");
    await fails(assemble({ ...base, imports: [imp("time_unix_ms", 0, "i32")] }), "time_unix_ms");
  });
  it("refuses a missing export, a wrong signature and an extra export", async () => {
    await fails(assemble({ ...base, funcs: declarations().slice(0, 5) }), "missing export", "pn_update");
    const f = declarations();
    f[1] = { sig: { params: ["i32"], results: ["i32"] }, body: op.i32const(1), export: "pn_update_hz" };
    await fails(assemble({ ...base, funcs: f }), "export with another signature", "pn_update_hz");
    await fails(
      assemble({
        ...base,
        funcs: [...declarations(), { sig: { params: [], results: [] }, body: [], export: "extra" }],
      }),
      "export outside",
      "extra",
    );
  });
  it("refuses no memory exported as `memory`, two memories and an initial size over 4 pages", async () => {
    await fails(assemble({ ...base, memoryExport: "mem" }), "memory not exported");
    await fails(assemble({ ...base, memory: null }), "memory not exported");
    await fails(assemble({ ...base, extraMemory: true }), "more than one memory");
    await fails(assemble({ ...base, memory: { min: 5, max: 6 } }), "memory too large", "5 pages");
  });
  it("refuses a start function", async () => {
    await fails(assemble({ ...base, start: 4 }), "start function");
  });
  it("refuses another ABI major or a newer minor, naming both versions", async () => {
    await fails(assemble({ ...base, funcs: declarations({ abi: 0x10001 }) }), "ABI version", "1.1", "0.1");
    await fails(assemble({ ...base, funcs: declarations({ abi: 2 }) }), "ABI version", "0.2");
  });
  it("refuses a rate outside 0 to 60 and a size outside 1 to 4096", async () => {
    await fails(assemble({ ...base, funcs: declarations({ hz: 61 }) }), "update rate", "61");
    await fails(assemble({ ...base, funcs: declarations({ hz: -1 }) }), "update rate");
    await fails(assemble({ ...base, funcs: declarations({ w: 0 }) }), "width");
    await fails(assemble({ ...base, funcs: declarations({ h: 4097 }) }), "height", "4097");
    expect((await loadModule(assemble({ ...base, funcs: declarations({ hz: 0, w: 4096, h: 1 }) }))).width).toBe(4096);
  });
  it("calls no export but the declarations before it fails on the version", async () => {
    // pn_init would trap; the version check must come first
    const f = declarations({ abi: 0x20000, init: op.unreachable });
    await fails(assemble({ ...base, funcs: f }), "ABI version", "2.0");
  });
});

describe("memory growth", () => {
  it("is bounded by the browser for a module that declares at most 4 pages", async () => {
    const m = await loadModule(assemble({ ...base, funcs: declarations() }));
    expect(m.boundedMemory).toBe(true);
    const unbounded = await loadModule(assemble({ ...base, memory: { min: 1 } }));
    expect(unbounded.boundedMemory).toBe(false);
  });
});
