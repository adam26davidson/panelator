// Test helper: makes every write under one root fail with ENOSPC (spec 114). Patches the `fs` and `fs.promises`
// objects and re-syncs the builtin ESM exports, so named imports of node builtins see the failure. Also usable as a
// preload: `node --import enospc-fs.mjs` with PANELATOR_ENOSPC_ROOT set.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";

const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
const WRITE_FLAGS = /[wa+]/;

export function installEnospc(root) {
  const state = { on: true, root: resolve(root) };
  const under = (p) => {
    if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
    const abs = resolve(p instanceof URL ? p.pathname : String(p));
    return abs === state.root || abs.startsWith(state.root + sep);
  };
  const fail = (p) => state.on && under(p);
  const saved = [];
  const patch = (obj, name, make) => {
    const orig = obj[name];
    saved.push([obj, name, orig]);
    obj[name] = make(orig);
  };
  for (const name of ["appendFile", "writeFile", "rename", "copyFile"]) {
    patch(fsp, name, (orig) => async function (a, b, ...r) { if (fail(name === "rename" || name === "copyFile" ? b : a)) throw enospc(); return orig.call(this, a, b, ...r); });
  }
  patch(fsp, "mkdir", (orig) => async function (p, ...r) { if (fail(p) && !fs.existsSync(p)) throw enospc(); return orig.call(this, p, ...r); });
  patch(fsp, "open", (orig) => async function (p, flags = "r", ...r) {
    const h = await orig.call(this, p, flags, ...r);
    if (typeof flags === "string" && WRITE_FLAGS.test(flags) && fail(p)) {
      for (const m of ["writeFile", "appendFile", "write"]) h[m] = async () => { if (state.on) throw enospc(); };
    }
    return h;
  });
  for (const name of ["appendFileSync", "writeFileSync"]) {
    patch(fs, name, (orig) => function (p, ...r) { if (fail(p)) throw enospc(); return orig.call(this, p, ...r); });
  }
  patch(fs, "mkdirSync", (orig) => function (p, ...r) { if (fail(p) && !fs.existsSync(p)) throw enospc(); return orig.call(this, p, ...r); });
  syncBuiltinESMExports();
  return {
    set on(v) { state.on = v; },
    get on() { return state.on; },
    restore() { for (const [o, n, f] of saved.reverse()) o[n] = f; syncBuiltinESMExports(); },
  };
}

if (process.env.PANELATOR_ENOSPC_ROOT) installEnospc(process.env.PANELATOR_ENOSPC_ROOT);
