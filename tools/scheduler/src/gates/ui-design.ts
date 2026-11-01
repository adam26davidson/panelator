import type { ParsedSpec } from "../spec/parse.ts";
import { ignore, pass, type GateResult } from "./types.ts";

const UI_DOMAINS = new Set(["web-ui", "widget"]);
/** Each named screen is rendered at these file-name suffixes (spec 029 AC-7; desktop is the bare name). */
const RENDER_SUFFIXES = ["", ".mobile", ".tablet"];

/**
 * `designFiles` are the file names under the spec's design/ directory. A failure labels nothing: it is the
 * reason the chain starts the design stage (spec 029 AC-1).
 */
export function uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult {
  if (!spec.domain || !UI_DOMAINS.has(spec.domain)) return pass;
  const problems: string[] = [];
  const hasStory = designFiles.some((f) => /\.stories\.(tsx?|jsx?|mdx)$/.test(f));
  const hasTokenPrototype = designFiles.some((f) => /^tokens.*\.html$/.test(f) || /-prototype\.html$/.test(f));
  if (!hasStory && !hasTokenPrototype) problems.push("no story or token prototype in design/");
  for (const screen of spec.uiScreens) {
    for (const suffix of RENDER_SUFFIXES) {
      if (!designFiles.includes(`${screen}${suffix}.png`)) problems.push(`missing ${screen}${suffix}.png`);
    }
  }
  return problems.length ? ignore("the design is incomplete: " + problems.join("; ")) : pass;
}
