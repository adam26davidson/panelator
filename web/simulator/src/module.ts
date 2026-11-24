import { EXPORTS, IMPORT_MODULE, IMPORTS, MAX_PAGES, sameSig, sigText } from "./abi.ts";
import { SimulatorError } from "./errors.ts";
import { readShape } from "./wasm-sections.ts";

/** A module that passed the load rules of docs/widget-abi.md "Module form and limits" (as far as a browser can check). */
export interface LoadedModule {
  readonly name: string;
  readonly module: WebAssembly.Module;
  readonly abi: { major: number; minor: number };
  readonly updateHz: number;
  readonly width: number;
  readonly height: number;
  /** True when the module declares a memory maximum of at most 4 pages, so the browser bounds `memory.grow`. */
  readonly boundedMemory: boolean;
}

const fail = (rule: string, detail: string, name: string): never => {
  throw new SimulatorError(rule, `${name}: ${rule}: ${detail}`, { module: name });
};

/**
 * Compiles `bytes` with the engine's WebAssembly and checks it against the document, or fails with a SimulatorError whose
 * message names the rule and the offending import, export or value. Calls the four declarations once.
 */
export async function loadModule(bytes: Uint8Array, name = "module"): Promise<LoadedModule> {
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes as BufferSource);
  } catch (e) {
    throw new SimulatorError("not a module", `${name}: not a module the engine compiles: ${(e as Error).message}`, {
      module: name,
      cause: e,
    });
  }
  let shape: ReturnType<typeof readShape>;
  try {
    shape = readShape(bytes);
  } catch (e) {
    throw new SimulatorError("not a module", `${name}: its sections cannot be read: ${(e as Error).message}`, {
      module: name,
      cause: e,
    });
  }
  for (const i of shape.imports) {
    const label = `${i.module}.${i.name}`;
    if (i.module !== IMPORT_MODULE || i.kind !== "function") {
      fail(
        "import outside the import table",
        `${label} (${i.kind}) is not a function of module ${IMPORT_MODULE}`,
        name,
      );
    }
    const want = IMPORTS[i.name];
    if (!want) fail("import outside the import table", `${label} is not in the import table`, name);
    else if (!i.sig || !sameSig(i.sig, want)) {
      fail(
        "import with another signature",
        `${label} is ${i.sig ? sigText(i.sig) : "?"}, the document has ${sigText(want)}`,
        name,
      );
    }
  }
  for (const [ename, want] of Object.entries(EXPORTS)) {
    const e = shape.exports.find((x) => x.name === ename);
    if (!e || e.kind !== "function") fail("missing export", `${ename} is not exported`, name);
    else if (!e.sig || !sameSig(e.sig, want)) {
      fail(
        "export with another signature",
        `${ename} is ${e.sig ? sigText(e.sig) : "?"}, the document has ${sigText(want)}`,
        name,
      );
    }
  }
  if (shape.memories.length > 1) fail("more than one memory", `${shape.memories.length} memories`, name);
  const mem = shape.exports.find((x) => x.name === "memory");
  if (mem?.kind !== "memory" || shape.memories.length !== 1 || shape.imports.some((i) => i.kind === "memory")) {
    fail("memory not exported", "the module's one memory must be exported as `memory`", name);
  }
  const limits = shape.memories[0] as { min: number; max: number | undefined };
  if (limits.min > MAX_PAGES)
    fail("memory too large", `the initial size is ${limits.min} pages, the limit is ${MAX_PAGES}`, name);
  const allowed = new Set([...Object.keys(EXPORTS), "memory"]);
  for (const e of shape.exports) {
    if (!allowed.has(e.name))
      fail("export outside the export table", `${e.name} is not an export of the document`, name);
  }
  if (shape.start !== undefined) fail("start function", `function ${shape.start} is the start function`, name);

  const refuse = (what: string): never => {
    throw new SimulatorError("declaration", `${name}: a declaration called ${what}`, { module: name });
  };
  const stubs = Object.fromEntries(Object.keys(IMPORTS).map((k) => [k, () => refuse(`the import ${k}`)]));
  let ex: Record<string, (...a: never[]) => number>;
  try {
    ex = (await WebAssembly.instantiate(module, { [IMPORT_MODULE]: stubs })).exports as never;
  } catch (e) {
    throw new SimulatorError("not instantiable", `${name}: ${(e as Error).message}`, { module: name, cause: e });
  }
  const call = (n: string): number => {
    try {
      return (ex[n] as () => number)();
    } catch (e) {
      if (e instanceof SimulatorError) throw e;
      throw new SimulatorError("declaration", `${name}: ${n} failed: ${(e as Error).message}`, {
        module: name,
        export: n,
        cause: e,
      });
    }
  };
  const version = call("pn_abi_version") >>> 0;
  const major = version >>> 16;
  const minor = version & 0xffff;
  if (major !== 0 || minor > 1) {
    fail("ABI version", `the module is ${major}.${minor}, the host is 0.1`, name);
  }
  const updateHz = call("pn_update_hz");
  if (updateHz < 0 || updateHz > 60) fail("update rate", `pn_update_hz is ${updateHz}, not 0 to 60`, name);
  const width = call("pn_width");
  if (width < 1 || width > 4096) fail("width", `pn_width is ${width}, not 1 to 4096`, name);
  const height = call("pn_height");
  if (height < 1 || height > 4096) fail("height", `pn_height is ${height}, not 1 to 4096`, name);
  return {
    name,
    module,
    abi: { major, minor },
    updateHz,
    width,
    height,
    boundedMemory: limits.max !== undefined && limits.max <= MAX_PAGES,
  };
}
