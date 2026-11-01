import type { ParsedSpec } from "../spec/parse.ts";
import { ignore, pass, type GateResult } from "./types.ts";

const UI_DOMAINS = new Set(["web-ui", "widget"]);

/** Spec 029 AC-5, AC-7: the three renders a named screen needs beside its story. */
export const RENDER_SUFFIXES = [".png", ".mobile.png", ".tablet.png"] as const;

export function rendersOf(screen: string): string[] {
  return RENDER_SUFFIXES.map((s) => `${screen}${s}`);
}

/**
 * Spec 029 AC-7: `designFiles` are the file names under the spec's design/ directory. A failure is a reason, never a
 * label: the shortlist makes the issue eligible and its chain starts at the design stage with the reason (AC-1).
 */
export function uiDesignGate(spec: ParsedSpec, designFiles: string[]): GateResult {
  if (!spec.domain || !UI_DOMAINS.has(spec.domain)) return pass;
  const problems: string[] = [];
  const hasStory = designFiles.some((f) => /\.stories\.(tsx?|jsx?|mdx)$/.test(f));
  const hasTokenPrototype = designFiles.some((f) => /^tokens.*\.html$/.test(f) || /-prototype\.html$/.test(f));
  if (!hasStory && !hasTokenPrototype) problems.push("no story or token prototype in design/");
  for (const screen of spec.uiScreens) {
    const missing = rendersOf(screen).filter((f) => !designFiles.includes(f));
    if (missing.length) problems.push(`screen ${screen}: missing ${missing.join(", ")}`);
  }
  return problems.length ? ignore(`UI design incomplete: ${problems.join("; ")}`) : pass;
}
