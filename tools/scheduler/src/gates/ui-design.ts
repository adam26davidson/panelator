import type { ParsedSpec } from "../spec/parse.ts";
import { ignore, pass, type GateResult } from "./types.ts";

const UI_DOMAINS = new Set(["web-ui", "widget"]);

/**
 * Spec 029 AC-7: each named screen needs its renders at the three viewports (`<screen>.png` is desktop) and the design a story or token prototype.
 * A failure labels nothing: it is the reason the chain starts at the design stage.
 * `designFiles` are the file names under the spec's design/ directory. */
export function uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult {
  if (!spec.domain || !UI_DOMAINS.has(spec.domain)) return pass;
  const problems: string[] = [];
  const hasStory = designFiles.some((f) => /\.stories\.(tsx?|jsx?|mdx)$/.test(f));
  const hasTokenPrototype = designFiles.some((f) => /^tokens.*\.html$/.test(f) || /-prototype\.html$/.test(f));
  if (!hasStory && !hasTokenPrototype) problems.push("no story or token prototype in design/");
  for (const screen of spec.uiScreens) {
    for (const file of [`${screen}.png`, `${screen}.mobile.png`, `${screen}.tablet.png`]) if (!designFiles.includes(file)) problems.push(`missing ${file}`);
  }
  return problems.length ? ignore(problems.join("; ")) : pass;
}
