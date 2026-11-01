import { render } from "./render.ts";

const args = process.argv.slice(2);
const flag = args.indexOf("--screen");
const screen = flag >= 0 ? args[flag + 1] : undefined;
const specDir = args.find((a, i) => !a.startsWith("--") && i !== flag + 1);

if (!specDir || (flag >= 0 && !screen)) {
  console.error("usage: render <spec dir> [--screen <name>]");
  process.exit(1);
}

try {
  for (const r of await render(specDir, { screen })) console.log(r.file);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
