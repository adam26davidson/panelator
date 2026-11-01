import { relative, resolve } from "node:path";
import { render } from "./render.ts";

const args = process.argv.slice(2);
let specDir: string | undefined;
let screen: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--screen") screen = args[++i];
  else specDir ??= args[i];
}
if (!specDir) {
  console.error("usage: render <spec dir> [--screen <name>]");
  process.exit(2);
}

try {
  // pnpm runs the script from the package directory; INIT_CWD is where the user typed the command.
  const base = process.env.INIT_CWD ?? process.cwd();
  const result = await render({ specDir: resolve(base, specDir), screen });
  for (const s of result) for (const r of s.renders) console.log(`${s.name}: ${relative(base, r)}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
