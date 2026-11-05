import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDone, resolveChildIssue } from "../children/markers.ts";
import { childSlugOfPath, parseChildEntries, parseChildren, parseSpec, type ChildEntry } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";

export const ROOT = "docs/charter.md";
export const TOP_DESIGNS = ["docs/product-spec.md", "docs/delivery-system-design.md"];

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Spec 031 AC-2: the checks on the planned children of one design; each reason names the design and the slug. */
function checkPlanned(path: string, entries: ChildEntry[], classes: string[] | undefined): string[] {
  const errors: string[] = [];
  const planned = entries.filter((e) => e.kind === "planned");
  const fileSlugs = new Set(entries.filter((e) => e.kind === "file").map((e) => childSlugOfPath(e.path!)).filter((s) => s !== null));
  const filePaths = new Set(entries.filter((e) => e.kind === "file").map((e) => e.path!));
  const seen = new Set<string>();
  for (const e of planned) {
    const at = `${path}: planned child ${e.slug || "(no slug)"}`;
    if (!SLUG.test(e.slug ?? "")) errors.push(`${at}: the slug does not match [a-z0-9][a-z0-9-]*`);
    if (e.error) errors.push(`${at}: ${e.error}`);
    if (seen.has(e.slug ?? "")) errors.push(`${at}: another child has the same slug`);
    seen.add(e.slug ?? "");
    if (fileSlugs.has(e.slug ?? "")) errors.push(`${at}: a spec with this slug exists, so the planned bullet should be replaced by the file bullet`);
    if (classes && e.class !== undefined && !classes.includes(e.class)) errors.push(`${at}: class ${e.class} is not a configured class label`);
    if (e.issueRaw !== undefined) errors.push(`${at}: issue: ${e.issueRaw} is not #<n>`);
    for (const ref of e.after) {
      if (ref === e.slug) errors.push(`${at}: after: names the entry itself`);
      else if (!planned.some((p) => p.slug === ref) && !filePaths.has(ref)) errors.push(`${at}: after: ${ref} names no sibling`);
    }
  }
  // A cycle among the planned siblings (file siblings are leaves).
  const after = new Map(planned.map((e) => [e.slug ?? "", e.after.filter((r) => r !== e.slug)]));
  const state = new Map<string, 1 | 2>();
  const visit = (slug: string, trail: string[]): void => {
    if (state.get(slug) === 2) return;
    if (state.get(slug) === 1) {
      errors.push(`${path}: planned child ${slug}: after: forms a cycle (${[...trail.slice(trail.indexOf(slug)), slug].join(" -> ")})`);
      return;
    }
    state.set(slug, 1);
    for (const r of after.get(slug) ?? []) if (after.has(r)) visit(r, [...trail, slug]);
    state.set(slug, 2);
  };
  for (const slug of after.keys()) visit(slug, []);
  return errors;
}

/** Errors in the design tree formed by Parent: and ## Children links; empty when valid. `classes` enables the `class:` check. */
export function checkDesignTree(files: Map<string, string>, opts: { classes?: string[] } = {}): string[] {
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
    const entries = parseChildEntries(text) ?? [];
    errors.push(...checkPlanned(path, entries, opts.classes));
    for (const child of children) {
      if (!files.has(child)) errors.push(`${path}: child ${child} does not exist`);
      else if (parentOf.get(child) !== path) {
        errors.push(`${path}: child ${child} names ${parentOf.get(child) ?? "no parent"} as its parent`);
      }
    }
    if (path.startsWith("docs/designs/") && entries.length < 2) {
      errors.push(`${path}: a sub-design needs at least two children, has ${entries.length}`);
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

export interface ReportEntry extends ChildEntry {
  /** Planned children: the recorded issue (`issue:` or the bot-authored marker), when the caller passed the issues. */
  recordedIssue?: number;
  done?: boolean;
  /** Planned children: the class label, the entry's or the default by top ancestor. */
  effectiveClass?: string;
}

const DEFAULT_CLASS: Record<string, string> = { "docs/product-spec.md": "class:product", "docs/delivery-system-design.md": "class:tooling" };

/** The top design a design descends from, following Parent: lines; null when none is reached. */
export function topAncestor(files: Map<string, string>, path: string): string | null {
  const seen = new Set<string>();
  for (let cur: string | null = path; cur && !seen.has(cur); cur = parseSpec(files.get(cur) ?? "").parent) {
    if (TOP_DESIGNS.includes(cur)) return cur;
    seen.add(cur);
  }
  return null;
}

/** The class label of a planned child: its `class:`, else the default by the design's top ancestor. */
export function childClass(files: Map<string, string>, design: string, entry: ChildEntry): string {
  return entry.class ?? DEFAULT_CLASS[topAncestor(files, design) ?? ""] ?? "class:tooling";
}

/** Per design (the top designs and docs/designs/*), its child entries; the seam spec 028's design_tree input takes planned children from. */
export function designTreeReport(
  root: string,
  opts: { issues?: IssueData[]; botLogin?: string } = {},
): Map<string, ReportEntry[]> {
  const files = loadDesignTree(root);
  const out = new Map<string, ReportEntry[]>();
  for (const [path, text] of files) {
    if (!TOP_DESIGNS.includes(path) && !path.startsWith("docs/designs/")) continue;
    const entries: ReportEntry[] = (parseChildEntries(text) ?? []).map((e) => ({ ...e }));
    for (const e of entries) {
      if (e.kind !== "planned") continue;
      e.effectiveClass = childClass(files, path, e);
      if (!opts.issues) continue;
      const r = resolveChildIssue(e, path, opts.issues, opts.botLogin ?? "");
      if (r.number !== null) e.recordedIssue = r.number;
      e.done = !!r.issue && !r.dead && isDone(r.issue);
    }
    out.set(path, entries);
  }
  return out;
}
