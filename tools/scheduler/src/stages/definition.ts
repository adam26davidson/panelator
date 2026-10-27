import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isBounds, type AgentStageName, type StageDefinition } from "../types.ts";

const STAGES: AgentStageName[] = ["plan", "implement", "review", "fix", "spec", "question-check"];

export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error("stage definition: missing YAML frontmatter");
  return { frontmatter: m[1], body: m[2] };
}

export function parseStageDefinition(markdown: string): StageDefinition {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fm = parse(frontmatter) as Record<string, unknown>;
  const req = (k: string): string => {
    const v = fm[k];
    if (typeof v !== "string" || !v) throw new Error(`stage definition: ${k} is required`);
    return v;
  };
  const name = req("name");
  if (!STAGES.includes(name as AgentStageName)) throw new Error(`stage definition: unknown stage name ${name}`);
  if (req("kind") !== "agent") throw new Error("stage definition: kind must be agent");
  const harness = req("harness");
  if (harness !== "claude" && harness !== "pi") throw new Error(`stage definition: harness must be claude or pi, got ${harness}`);
  const tier = req("tier");
  if (tier !== "strong" && tier !== "standard") throw new Error("stage definition: tier must be strong or standard");
  if (!isBounds(fm.bounds)) throw new Error("stage definition: bounds needs timeout_min, max_turns, max_cost_usd");
  if (req("permission") !== "no-prompt") throw new Error("stage definition: permission must be no-prompt");
  const worktree = req("worktree");
  if (worktree !== "issue" && worktree !== "fresh") throw new Error("stage definition: worktree must be issue or fresh");
  const fallback = typeof fm.fallback === "string" ? fm.fallback : undefined;
  if (fm.independent !== undefined && typeof fm.independent !== "boolean") throw new Error("stage definition: independent must be a boolean");
  const independent = fm.independent === true;
  if (fallback && tier === "strong" && !independent) throw new Error("stage definition: a strong-tier stage may not name a fallback unless independent (AC-25, AC-26)");
  return {
    name: name as AgentStageName,
    kind: "agent",
    harness,
    model: req("model"),
    fallback,
    independent,
    tier,
    effort: typeof fm.effort === "string" ? fm.effort : undefined,
    bounds: fm.bounds,
    permission: "no-prompt",
    worktree,
    profile: req("profile"),
    input: req("input"),
    output: req("output"),
    prompt: body,
  };
}

export function loadStageDefinitions(dir: string): Record<AgentStageName, StageDefinition> {
  const out = {} as Record<AgentStageName, StageDefinition>;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const d = parseStageDefinition(readFileSync(join(dir, f), "utf8"));
    out[d.name] = d;
  }
  for (const s of STAGES) if (!out[s]) throw new Error(`stage definition missing: ${s}`);
  return out;
}
