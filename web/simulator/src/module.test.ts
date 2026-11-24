import { describe, expect, it } from "vitest";
import { SimulatorError } from "./errors.ts";
import { loadModule } from "./module.ts";
import { assemble, call, grow, type ModuleSpec } from "./testwasm.ts";
import { sceneOf } from "./scenehelp.ts";

const rejects = async (spec: ModuleSpec | Uint8Array, ...parts: string[]) => {
  const err = await loadModule(spec instanceof Uint8Array ? spec : assemble(spec)).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SimulatorError);
  for (const p of parts) expect((err as Error).message).toContain(p);
};

describe("loadModule (AC-3)", () => {
  it("loads a conforming module and reports its four declarations", async () => {
    const m = await loadModule(assemble({ hz: 30, width: 12, height: 5 }));
    expect([m.abi, m.updateHz, m.width, m.height]).toEqual([1, 30, 12, 5]);
  });

  it("refuses bytes that are not a module", async () => {
    await rejects(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), "module form");
  });

  it("refuses an import outside the table, from another module, of another kind or with another signature", async () => {
    await rejects({ imports: [{ name: "draw_nothing", params: [], results: [] }] }, "imports", "draw_nothing");
    await rejects({ imports: [{ module: "env", name: "layer_width", params: [], results: ["i32"] }] }, "imports", "env.layer_width");
    await rejects({ imports: [{ name: "layer_width", params: [], results: ["i64"] }] }, "imports", "layer_width", "signature");
    await rejects({ imports: [{ name: "draw_pixel", params: ["i32", "i32"], results: [] }] }, "imports", "draw_pixel");
  });

  it("refuses a missing export, a wrong signature and an extra export", async () => {
    await rejects({ omit: ["pn_init"] }, "exports", "pn_init", "missing");
    await rejects({ sigOverride: { pn_update: { params: ["i32"], results: [] } } }, "pn_update", "signature");
    await rejects({ extraExport: "pn_extra" }, "pn_extra");
  });

  it("refuses no memory exported as `memory`, two memories and an initial size over 4 pages", async () => {
    await rejects({ exportMemory: false }, "memory");
    await rejects({ memories: [] }, "memory");
    await rejects({ memories: [{ min: 1 }, { min: 1 }] }, "memory", "2 memories");
    await rejects({ memories: [{ min: 5 }] }, "memory", "5 pages");
  });

  it("refuses a start function", async () => {
    await rejects({ start: 20 }, "start function");
  });

  it("refuses another ABI major or a newer minor, naming both versions", async () => {
    await rejects({ version: 0x10000 }, "version", "1.0", "0.1");
    await rejects({ version: 2 }, "version", "0.2", "0.1");
  });

  it("calls no export but the declarations before it fails on the version", async () => {
    // pn_init would call an import, which the declarations' instance refuses: the load fails on the version, not there.
    await rejects({ version: 0x20000, init: call("draw_fill", -1) }, "version", "2.0");
  });

  it("refuses a rate outside 0 to 60 and a size outside 1 to 4096", async () => {
    await rejects({ hz: 61 }, "pn_update_hz", "61");
    await rejects({ hz: -1 }, "pn_update_hz");
    await rejects({ width: 0 }, "pn_width");
    await rejects({ width: 4097 }, "pn_width", "4097");
    await rejects({ height: 0 }, "pn_height");
    await rejects({ height: 4097 }, "pn_height");
    await expect(loadModule(assemble({ hz: 0, width: 4096, height: 1 }))).resolves.toBeDefined();
  });
});

describe("memory growth (AC-3)", () => {
  it("is bounded by the browser for a module that declares at most 4 pages", async () => {
    const m = await loadModule(assemble({ memories: [{ min: 1, max: 4 }] }));
    expect(m.growthBounded).toBe(true);
    // memory.grow past the declared maximum returns -1 (the browser's), and the run goes on
    const scene = await sceneOf({ width: 2, height: 1 }, [{ width: 2, height: 1, spec: { memories: [{ min: 1, max: 4 }], init: grow(10) } }]);
    expect(scene.tick).toBe(-1);
  });

  it("a module with no declared maximum that grows past 4 pages ends the run, naming the limit", async () => {
    const make = (pages: number) =>
      sceneOf({ width: 2, height: 1 }, [{ width: 2, height: 1, spec: { init: grow(pages) } }]);
    await expect(make(3)).resolves.toBeDefined(); // 1 + 3 = 4 pages is inside
    const err = await make(4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulatorError);
    expect((err as Error).message).toContain("limit of 4 pages");
    expect((err as SimulatorError).placement).toBe(0);
  });

  it("a module declaring a maximum over 4 pages is checked, not bounded", async () => {
    const m = await loadModule(assemble({ memories: [{ min: 1, max: 8 }] }));
    expect(m.growthBounded).toBe(false);
  });
});
