import {
  ABI_MAJOR,
  ABI_MINOR,
  DECLARATIONS,
  EXPORT_TABLE,
  IMPORT_MODULE,
  IMPORT_TABLE,
  MAX_PAGES,
  type Signature,
} from "./abi.ts";
import { SimulatorError } from "./errors.ts";
import { type FuncType, readSections, valTypeName } from "./sections.ts";

export interface LoadedModule {
  readonly module: WebAssembly.Module;
  /** `pn_abi_version`: `(major << 16) | minor`. */
  readonly abi: number;
  readonly updateHz: number;
  readonly width: number;
  readonly height: number;
  /** True when the browser bounds `memory.grow`, because the module declares a maximum of at most 4 pages. */
  readonly growthBounded: boolean;
}

const fail = (rule: string, detail: string): never => {
  throw new SimulatorError(`${rule}: ${detail}`, { rule });
};

const text = (s: Signature): string => `(${s.params.join(", ")}) -> (${s.results.join(", ")})`;
const typeText = (t: FuncType): string =>
  `(${t.params.map(valTypeName).join(", ")}) -> (${t.results.map(valTypeName).join(", ")})`;
const same = (t: FuncType, s: Signature): boolean =>
  t.params.length === s.params.length &&
  t.results.length === s.results.length &&
  t.params.every((p, i) => valTypeName(p) === s.params[i]) &&
  t.results.every((p, i) => valTypeName(p) === s.results[i]);

/** Loads a widget module by the rules of docs/widget-abi.md "Module form and limits", "Exports" and "Version". */
export async function loadModule(bytes: Uint8Array): Promise<LoadedModule> {
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes as BufferSource);
  } catch (cause) {
    throw new SimulatorError(`module form: the browser does not compile these bytes: ${String(cause)}`, {
      rule: "module form",
      cause,
    });
  }
  const sec = readSections(bytes);

  const importedFuncTypes: number[] = [];
  for (const imp of sec.imports) {
    const label = `import ${imp.module}.${imp.name}`;
    if (imp.kind !== 0) fail("imports", `${label} is not a function`);
    if (imp.module !== IMPORT_MODULE) fail("imports", `${label} is not from the import module "${IMPORT_MODULE}"`);
    const want = IMPORT_TABLE[imp.name];
    if (!want || !Object.hasOwn(IMPORT_TABLE, imp.name)) fail("imports", `${label} is not in the import table`);
    const have = sec.types[imp.type ?? -1];
    if (!have || !same(have, want as Signature))
      fail(
        "imports",
        `${label} has signature ${have ? typeText(have) : "unknown"}, expected ${text(want as Signature)}`,
      );
    importedFuncTypes.push(imp.type as number);
  }

  const funcType = (index: number): FuncType | undefined => {
    const typeIndex =
      index < importedFuncTypes.length ? importedFuncTypes[index] : sec.functions[index - importedFuncTypes.length];
    return typeIndex === undefined ? undefined : sec.types[typeIndex];
  };

  let memoryExport = false;
  const seen = new Set<string>();
  for (const exp of sec.exports) {
    if (exp.name === "memory") {
      if (exp.kind !== 2) fail("exports", `export memory is not a memory`);
      memoryExport = true;
      continue;
    }
    const want = EXPORT_TABLE[exp.name];
    if (!want || !Object.hasOwn(EXPORT_TABLE, exp.name))
      fail("exports", `export ${exp.name} is not in the export table`);
    if (exp.kind !== 0) fail("exports", `export ${exp.name} is not a function`);
    const have = funcType(exp.index);
    if (!have || !same(have, want as Signature))
      fail(
        "exports",
        `export ${exp.name} has signature ${have ? typeText(have) : "unknown"}, expected ${text(want as Signature)}`,
      );
    seen.add(exp.name);
  }
  for (const name of Object.keys(EXPORT_TABLE)) if (!seen.has(name)) fail("exports", `export ${name} is missing`);
  if (!memoryExport) fail("memory", "no memory is exported as `memory`");
  const memoryCount = sec.memories.length + sec.importedMemories;
  if (memoryCount !== 1) fail("memory", `${memoryCount} memories (exactly one is allowed)`);
  const memory = sec.memories[0];
  if (!memory) fail("memory", "the memory is not defined by the module");
  const limits = memory as { min: number; max: number | undefined };
  if (limits.min > MAX_PAGES)
    fail("memory", `initial size ${limits.min} pages is over the limit of ${MAX_PAGES} pages`);
  if (sec.start !== undefined) fail("start function", `the module has a start function (function ${sec.start})`);

  // The declarations are called once, after instantiation and before pn_init; none of them calls an import.
  const refuse = (name: string) => () => {
    throw new SimulatorError(`declarations: ${name} was called while the declarations ran`, { rule: "declarations" });
  };
  const imports: Record<string, WebAssembly.ImportValue> = {};
  for (const name of Object.keys(IMPORT_TABLE)) imports[name] = refuse(name);
  const instance = await WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports });
  const call = (name: string): number => {
    const f = instance.exports[name] as () => number;
    try {
      return f();
    } catch (cause) {
      throw new SimulatorError(`declarations: ${name} failed: ${String(cause)}`, {
        rule: "declarations",
        export: name,
        cause,
      });
    }
  };
  const abi = call(DECLARATIONS[0]);
  const major = abi >>> 16;
  const minor = abi & 0xffff;
  if (major !== ABI_MAJOR || minor > ABI_MINOR)
    fail("version", `the module is built for ABI ${major}.${minor}, the engine is ${ABI_MAJOR}.${ABI_MINOR}`);
  const updateHz = call(DECLARATIONS[1]);
  if (!(updateHz >= 0 && updateHz <= 60)) fail("declarations", `pn_update_hz is ${updateHz}, outside 0 to 60`);
  const width = call(DECLARATIONS[2]);
  if (!(width >= 1 && width <= 4096)) fail("declarations", `pn_width is ${width}, outside 1 to 4096`);
  const height = call(DECLARATIONS[3]);
  if (!(height >= 1 && height <= 4096)) fail("declarations", `pn_height is ${height}, outside 1 to 4096`);

  return {
    module,
    abi,
    updateHz,
    width,
    height,
    growthBounded: limits.max !== undefined && limits.max <= MAX_PAGES,
  };
}
