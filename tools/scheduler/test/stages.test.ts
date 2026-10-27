import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { loadStageDefinitions, parseStageDefinition } from "../src/stages/definition.ts";
import { renderPrompt } from "../src/stages/prompt.ts";

const minimal = `---
name: review
kind: agent
harness: claude
model: claude-fable-5-1
tier: strong
bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: review-result
---
Review {{issue}} and write {{result_path}}.
`;

describe("parseStageDefinition", () => {
  it("parses frontmatter and body", () => {
    const d = parseStageDefinition(minimal);
    expect(d.name).toBe("review");
    expect(d.bounds).toEqual({ timeout_min: 40, max_turns: 150, max_cost_usd: 6 });
    expect(d.prompt.trim()).toBe("Review {{issue}} and write {{result_path}}.");
  });
  it("rejects a fallback on a strong-tier stage (AC-25)", () => {
    expect(() => parseStageDefinition(minimal.replace("tier: strong", "tier: strong\nfallback: claude-opus-5-5"))).toThrow(/fallback/);
  });
  it("rejects a missing bounds field", () => {
    expect(() => parseStageDefinition(minimal.replace("max_cost_usd: 6", "x: 1"))).toThrow(/bounds/);
  });
  it("rejects an unknown harness", () => {
    expect(() => parseStageDefinition(minimal.replace("harness: claude", "harness: codex"))).toThrow(/harness/);
  });
});

describe("committed stage definitions", () => {
  it("load all four v0 stages with the spec's tiers", () => {
    const d = loadStageDefinitions(`${agentsDir}/stages`);
    expect(Object.keys(d).sort()).toEqual(["fix", "implement", "plan", "review"]);
    expect(d.plan.tier).toBe("strong");
    expect(d.review.tier).toBe("strong");
    expect(d.implement.tier).toBe("standard");
    expect(d.fix.tier).toBe("standard");
    expect(d.plan.output).toBe("plan-result");
    expect(d.review.output).toBe("review-result");
    for (const s of Object.values(d)) expect(s.prompt).toContain("{{result_path}}");
  });
});

describe("renderPrompt", () => {
  const input = {
    issue: { number: 7, title: "Add thing", body: "Spec: specs/010-thing/spec.md" },
    spec: "# spec",
    result_path: "/tmp/r.json",
    profile_instructions: "Use cargo.",
  };
  it("fills placeholders", () => {
    const out = renderPrompt("Issue #{{issue}}\n{{spec}}\n{{profile_instructions}}\n-> {{result_path}}", input);
    expect(out).toContain("#7 Add thing");
    expect(out).toContain("Spec: specs/010-thing/spec.md");
    expect(out).toContain("# spec");
    expect(out).toContain("Use cargo.");
    expect(out).toContain("-> /tmp/r.json");
  });
  it("renders plan as JSON and empty optionals as (none)", () => {
    const out = renderPrompt("{{plan}} | {{ci}}", { ...input, plan: { verdict: "ready", domain: "backend", tasks: [] } });
    expect(out).toContain('"verdict": "ready"');
    expect(out).toContain("| (none)");
  });
  it("renders the spec 006 placeholders, (none) when absent", () => {
    expect(renderPrompt("{{mode}}|{{history}}|{{answer}}", { ...input, mode: "revise", history: "h" })).toBe("revise|h|(none)");
    expect(renderPrompt("{{question}}{{decide_input}}{{spec_problem}}{{answered_questions}}", input)).toBe("(none)".repeat(4));
  });
  it("throws on an unknown placeholder", () => {
    expect(() => renderPrompt("{{nope}}", input)).toThrow(/unknown placeholder/);
  });
});
