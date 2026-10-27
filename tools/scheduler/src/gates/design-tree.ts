import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChildren, parseSpec } from "../spec/parse.ts";

export const ROOT = "docs/charter.md";
export const TOP_DESIGNS = ["docs/product-spec.md", "docs/delivery-system-design.md"];

/** Errors in the design tree formed by Parent: and ## Children links; empty when valid. */
export function checkDesignTree(files: Map<string, string>): string[] {
  const errors: string[] = [];
  const parentOf = new Map<string, string | null>();
  for (const [path, text] of files) parentOf.set(path, parseSpec(text).parent);

  const rootText = files.get(ROOT);
  if (rootText !== undefined && parseChildren(rootText) !== null) errors.push(`${ROOT}: the root has a Children section`);

  for (const [path, text] of files) {
    if (path === ROOT) continue;
    const parent = parentOf.get(path) ?? null;
    if (!parent) {
      errors.push(`${path}: no Parent line`);
      continue;
    }
    const parentText = files.get(parent);
    if (parentText === undefined) {
      errors.push(`${path}: parent ${parent} does not exist`);
    } else if (parent !== ROOT && !(parseChildren(parentText) ?? []).includes(path)) {
      errors.push(`${path}: not listed in the Children of its parent ${parent}`);
    }

    const children = parseChildren(text) ?? [];
    for (const child of children) {
      if (!files.has(child)) errors.push(`${path}: child ${child} does not exist`);
      else if (parentOf.get(child) !== path) {
        errors.push(`${path}: child ${child} names ${parentOf.get(child) ?? "no parent"} as its parent`);
      }
    }
    if (path.startsWith("docs/designs/") && children.length < 2) {
      errors.push(`${path}: a sub-design needs at least two children, has ${children.length}`);
    }

    const seen = new Set([path]);
    for (let cur: string | null = parent; cur && cur !== ROOT; cur = parentOf.get(cur) ?? null) {
      if (seen.has(cur)) {
        errors.push(`${path}: Parent links form a cycle through ${cur}`);
        break;
      }
      seen.add(cur);
    }
  }
  return errors;
}

/** Reads the charter, the top designs, docs/designs and every spec.md under specs, relative to root. */
export function loadDesignTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const add = (rel: string) => {
    if (existsSync(join(root, rel))) files.set(rel, readFileSync(join(root, rel), "utf8"));
  };
  add(ROOT);
  for (const t of TOP_DESIGNS) add(t);
  const list = (dir: string) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).sort() : []);
  for (const f of list("docs/designs")) if (f.endsWith(".md")) add(`docs/designs/${f}`);
  for (const d of list("specs")) add(`specs/${d}/spec.md`);
  return files;
}
