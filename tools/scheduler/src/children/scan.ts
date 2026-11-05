import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { childClass } from "../gates/design-tree.ts";
import type { IssueComment } from "../github/types.ts";
import { parseChildEntries, type ChildEntry } from "../spec/parse.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";
import type { IssueData } from "../types.ts";
import { blockedMarker, childMarker, isDone, neutraliseChildMarkers, resolveChildIssue, unblockedMarker } from "./markers.ts";

const BLOCKED = "blocked";
const VALIDATED = "validated";
/** Consecutive scans on which a child's issue could not be filed before a finding goes to the maintainer (AC-4). */
export const FILING_FAILURES_BEFORE_FINDING = 3;

export interface ChildrenGh {
  listIssues(opts: { state: "all"; labelEvents?: boolean }): Promise<IssueData[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<unknown>;
  listComments(issue: number): Promise<IssueComment[]>;
}

export interface ChildrenDeps {
  gh: ChildrenGh;
  paths: StatePaths;
  botLogin: string;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  /** Every design file on main, by repo-relative path (`loadDesignTree`). */
  designs: Map<string, string>;
}

export interface ChildrenResult {
  filed: number[];
  unblocked: number[];
  errors: string[];
}

type Failures = Record<string, { count: number; error: string }>;

async function readFailures(path: string): Promise<Failures> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Failures) : {};
  } catch {
    return {};
  }
}

async function writeFailures(path: string, f: Failures): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(f, null, 2));
  await rename(tmp, path);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The planned entries of a design, with each one after the planned siblings its `after:` names (file order otherwise). */
function inDependencyOrder(planned: ChildEntry[]): ChildEntry[] {
  const out: ChildEntry[] = [];
  const left = [...planned];
  while (left.length) {
    const i = left.findIndex((e) => e.after.every((r) => !left.some((o) => o !== e && o.slug === r)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/**
 * Spec 031 AC-4 to AC-7: files one App-authored `validated` issue per planned child with no issue,
 * blocks it when an `after:` sibling is not done, and removes a `blocked` the scan itself added.
 * GitHub is the record (markers in bodies and comments); the state directory holds only the failure counter.
 */
export async function fileDesignChildren(d: ChildrenDeps): Promise<ChildrenResult> {
  const result: ChildrenResult = { filed: [], unblocked: [], errors: [] };
  const issues = await d.gh.listIssues({ state: "all", labelEvents: false });
  const failuresBefore = await readFailures(d.paths.childrenFailures);
  const failuresNow: Failures = {};
  const filedNow = new Set<number>();
  const planned: { design: string; entries: ChildEntry[]; all: ChildEntry[] }[] = [];

  for (const [design, text] of d.designs) {
    const all = parseChildEntries(text);
    if (!all) continue;
    const entries = all.filter((e) => e.kind === "planned" && !e.error && e.slug);
    if (entries.length) planned.push({ design, entries, all });
  }

  /** Who an `after:` reference is, and whether that sibling is done. */
  const sibling = (design: string, all: ChildEntry[], slug: string, ref: string, quiet: boolean): { label: string; done: boolean } => {
    const plannedSibling = all.find((e) => e.kind === "planned" && e.slug === ref);
    if (plannedSibling) {
      const r = resolveChildIssue(plannedSibling, design, issues, d.botLogin);
      return { label: r.number !== null ? `#${r.number}` : ref, done: !!r.issue && !r.dead && isDone(r.issue) };
    }
    const fileSibling = all.find((e) => e.kind === "file" && e.path === ref);
    if (fileSibling?.issue !== undefined) {
      const issue = issues.find((i) => i.number === fileSibling.issue);
      return { label: `#${fileSibling.issue}`, done: !!issue && isDone(issue) };
    }
    if (!quiet) d.log({ kind: "child-after-unknown", design, slug, ref });
    return { label: ref, done: true };
  };

  for (const { design, entries, all } of planned) {
    for (const entry of inDependencyOrder(entries)) {
      const slug = entry.slug!;
      const resolved = resolveChildIssue(entry, design, issues, d.botLogin);
      if (resolved.dead) {
        d.log({ kind: "child-issue-dead", design, slug, issue: resolved.number });
        continue;
      }
      if (resolved.number !== null) continue;

      const siblings = entry.after.map((ref) => ({ ref, ...sibling(design, all, slug, ref, false) }));
      const blocked = siblings.some((s) => !s.done);
      const afterLine = siblings.length ? `After: ${siblings.map((s) => s.label).join(", ")}\n\n` : "";
      const brief = neutraliseChildMarkers((entry.brief ?? "").replace(/^\s*Spec:.*$/gm, ""));
      const body =
        `${brief}\n\n` +
        `Parent design: \`${design}\` (planned child \`${slug}\`).\n\n` +
        `The spec for this work names \`${design}\` on its \`Parent:\` line, lives at \`specs/NNN-${slug}/spec.md\` with the next free number, ` +
        `and replaces the planned entry with the spec's path in the design's \`## Children\` section.\n\n` +
        afterLine +
        childMarker(design, slug);
      const labels = [childClass(d.designs, design, entry), VALIDATED, ...(blocked ? [BLOCKED] : [])];
      const key = `${design}:${slug}`;
      let number: number;
      try {
        number = await d.gh.createIssue(neutraliseChildMarkers(entry.title ?? slug), body, labels);
      } catch (e) {
        const error = message(e);
        d.log({ kind: "child-filing-failed", design, slug, error });
        result.errors.push(`${key}: ${error}`);
        const count = (failuresBefore[key]?.count ?? 0) + 1;
        if (count >= FILING_FAILURES_BEFORE_FINDING) {
          await appendFindings(
            d.paths,
            { issue: 0, stage: "children-scan", run_id: "children-scan", timestamp: d.now().toISOString() },
            [{ what: `the planned child ${slug} cannot be filed as an issue`, where: key, evidence: error, noticed_how: `the children scan failed ${count} scans in a row` }],
          );
        } else failuresNow[key] = { count, error };
        continue;
      }
      issues.push({ number, title: entry.title ?? slug, author: d.botLogin, body, labels, labelEvents: [], createdAt: d.now().toISOString(), state: "open" });
      filedNow.add(number);
      result.filed.push(number);
      d.log({ kind: "child-filed", design, slug, issue: number });
      if (blocked) {
        const waiting = siblings.filter((s) => !s.done);
        try {
          await d.gh.comment(
            number,
            `Blocked until ${waiting.map((s) => s.label).join(", ")} are done (after: ${entry.after.join(", ")} in ${design}).\n\n${blockedMarker(design, slug)}`,
          );
        } catch (e) {
          d.log({ kind: "child-filing-failed", design, slug, error: `blocked comment: ${message(e)}` });
          result.errors.push(`${key}: blocked comment: ${message(e)}`);
        }
      }
    }
  }
  await writeFailures(d.paths.childrenFailures, failuresNow);

  // AC-6: remove a `blocked` this scan added, once every `after:` sibling is done.
  for (const { design, entries, all } of planned) {
    for (const entry of entries) {
      const slug = entry.slug!;
      const resolved = resolveChildIssue(entry, design, issues, d.botLogin);
      const issue = resolved.issue;
      if (!issue || resolved.dead || filedNow.has(issue.number) || issue.state !== "open" || !issue.labels.includes(BLOCKED)) continue;
      try {
        const comments = await d.gh.listComments(issue.number);
        const bot = comments.filter((c) => c.author === d.botLogin);
        if (!bot.some((c) => c.body.includes(blockedMarker(design, slug)))) continue;
        if (bot.some((c) => c.body.includes(unblockedMarker(design, slug)))) continue;
        const siblings = entry.after.map((ref) => sibling(design, all, slug, ref, true));
        if (siblings.some((s) => !s.done)) continue;
        await d.gh.removeLabel(issue.number, BLOCKED);
        issue.labels = issue.labels.filter((l) => l !== BLOCKED);
        await d.gh.comment(issue.number, `Unblocked: ${siblings.map((s) => s.label).join(", ") || "its siblings"} are done.\n\n${unblockedMarker(design, slug)}`);
        result.unblocked.push(issue.number);
        d.log({ kind: "child-unblocked", design, slug, issue: issue.number });
      } catch (e) {
        result.errors.push(`${design}:${slug}: unblock: ${message(e)}`);
      }
    }
  }
  return result;
}
