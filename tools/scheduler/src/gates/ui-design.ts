import type { ParsedSpec } from "../spec/parse.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_DESIGN = "needs-design";
const UI_DOMAINS = new Set(["web-ui", "widget"]);

/** `designFiles` are the file names under the spec's design/ directory. */
export function uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult {
  if (!spec.domain || !UI_DOMAINS.has(spec.domain)) return pass;
  const problems: string[] = [];
  const hasStory = designFiles.some((f) => /\.stories\.(tsx?|jsx?|mdx)$/.test(f));
  const hasTokenPrototype = designFiles.some((f) => /^tokens.*\.html$/.test(f) || /-prototype\.html$/.test(f));
  if (!hasStory && !hasTokenPrototype) problems.push("no story or token prototype in design/");
  for (const screen of spec.uiScreens) if (!designFiles.includes(`${screen}.png`)) problems.push(`missing ${screen}.png`);
  return problems.length ? label(NEEDS_DESIGN, problems.join("; ")) : pass;
}
