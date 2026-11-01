import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { loadStageDefinitions, parseStageDefinition } from "../src/stages/definition.ts";
import { resolveProfile } from "../src/profiles/resolve.ts";
import { renderReplyPrompt,renderPrompt } from "../src/stages/prompt.ts";

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

describe('resumed reply prompt',()=>{
 it('keeps the cited answers, conversation rules and the new result path',()=>{
  const text=renderReplyPrompt({answer:'Question #10: why not the second?\n\nQuestion #11: Use second',mode:'work',result_path:'/new/result.json',conversation:true,stage:'plan'});
  expect(text).toContain('Question #10:');expect(text).toContain('Question #11:');expect(text).toContain('change nothing');expect(text).toContain('"conversation":"settled"');expect(text).toContain('/new/result.json');
 });
});

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
  it("accepts a strong-tier fallback only on an independent stage (AC-26)", () => {
    const withFallback = minimal.replace("tier: strong", "tier: strong\nfallback: claude-fable-5-1");
    const d = parseStageDefinition(withFallback.replace("tier: strong", "tier: strong\nindependent: true"));
    expect(d.fallback).toBe("claude-fable-5-1");
    expect(d.independent).toBe(true);
    expect(() => parseStageDefinition(withFallback)).toThrow(/may not name a fallback/);
    expect(() => parseStageDefinition(withFallback.replace("tier: strong", "tier: strong\nindependent: false"))).toThrow(/may not name a fallback/);
  });
  it("rejects a missing bounds field", () => {
    expect(() => parseStageDefinition(minimal.replace("max_cost_usd: 6", "x: 1"))).toThrow(/bounds/);
  });
  it("rejects an unknown harness", () => {
    expect(() => parseStageDefinition(minimal.replace("harness: claude", "harness: codex"))).toThrow(/harness/);
  });
});

describe("committed stage definitions", () => {
  it("load all six stages with the spec's tiers", () => {
    const d = loadStageDefinitions(`${agentsDir}/stages`);
    expect(Object.keys(d).sort()).toEqual(["design", "fix", "implement", "plan", "question-check", "review", "spec"]);
    expect(d.plan.tier).toBe("strong");
    expect(d.review.tier).toBe("strong");
    expect(d.implement.tier).toBe("standard");
    expect(d.fix.tier).toBe("standard");
    expect(d.plan.output).toBe("plan-result");
    expect(d.review.output).toBe("review-result");
    for (const s of Object.values(d)) expect(s.prompt).toContain("{{result_path}}");
  });
  it("define the question check as an independent pi stage with a Claude fallback (AC-12, AC-26)", () => {
    const q = loadStageDefinitions(`${agentsDir}/stages`)["question-check"];
    expect(q).toMatchObject({ harness: "pi", model: "openai/gpt-6.1-sol", independent: true, fallback: "claude-fable-5-1", input: "stage-input", tier: "strong", output: "question-check-result" });
  });
  it("define the spec stage as strong tier with the spec profile and no fallback (AC-21)", () => {
    const s = loadStageDefinitions(`${agentsDir}/stages`).spec;
    expect(s).toMatchObject({ tier: "strong", profile: "spec", output: "spec-result", harness: "claude", model: "claude-fable-5-1" });
    expect(s.fallback).toBeUndefined();
    expect(s.independent).toBe(false);
  });
});

describe("committed stage prompts (AC-1, AC-14, AC-15, AC-17)", () => {
  const read = (n: string) => readFileSync(join(agentsDir, "stages", `${n}.md`), "utf8");
  const full = {
    issue: { number: 7, title: "Add thing", body: "Spec: specs/010-thing/spec.md" },
    spec: "# spec",
    plan: { verdict: "ready" as const, domain: "backend", tasks: [] },
    pr: { number: 3, head_sha: "a".repeat(40), url: "https://example.invalid/pr/3" },
    ci: "test: success",
    findings: "f",
    fix_input: "fix this",
    history: "attempt 1 failed",
    question: "Which runtime?",
    answer: "WAMR (maintainer answer, question #99)",
    mode: "record" as const,
    decide_input: "decide it yourself",
    spec_problem: "missing spec",
    answered_questions: "#99 verified",
    result_path: "/tmp/r.json",
    profile_instructions: "Use cargo.",
  };
  it("review.md says the stage has no shell whatever the checks say (spec 017 AC-2)", () => {
    const t = read("review").replace(/\s+/g, " ");
    expect(t).toContain("you have no shell");
    expect(t).not.toContain("when every check succeeded");
  });
  for (const n of ["plan", "review", "question-check"]) {
    it(`${n}.md never tells a stage to run pnpm test without a shell condition (spec 017 AC-4)`, () => {
      const backend = resolveProfile(agentsDir, "backend").instructions;
      const out = renderPrompt(read(n), { ...full, profile_instructions: backend }).replace(/\s+/g, " ");
      for (const sentence of out.split(/\.(?: |$)/)) {
        if (sentence.includes("pnpm test")) expect(sentence).toContain("shell");
      }
    });
  }
  const narrowed = /that a user could notice a change does not make it a product decision/i;
  for (const n of ["plan", "implement", "fix", "review"]) {
    it(`${n}.md carries history, answer, decide input, escalation and the follow-up rule`, () => {
      const t = read(n);
      expect(t).toContain("{{history}}");
      expect(t).toContain("{{answer}}");
      expect(t).toContain("{{decide_input}}");
      expect(t).toMatch(/`escalation`/);
      for (const f of ["kind", "question", "options", "label", "cost", "recommendation"]) expect(t).toContain(`"${f}"`);
      expect(t).toMatch(/follow-up/);
      expect(t).toMatch(narrowed);
      expect(t).not.toMatch(/a user would notice/i);
    });
  }
  for (const n of ["plan", "implement", "fix", "review", "spec"]) {
    it(`${n}.md marks a follow-up with follow_up and reply_quote, and a decide-mode new blocker with new_blocker (C2, C3)`, () => {
      const t = read(n).replace(/\s+/g, " ");
      expect(t).toMatch(/"follow_up": true` and `"reply_quote"`/);
      expect(t).toMatch(/Any other question, even with an answer present, is checked as usual\./);
      expect(t).toMatch(/"new_blocker": true/);
      // CM2: any new blocker goes to the check, which sees the question sent back.
      expect(t).toMatch(/The question check then judges it, with the question sent back and its reasoning beside it/);
      expect(t).not.toMatch(/different kind from/);
      // Tm1: the quote is from the latest reply, at least 15 characters, a question or a request.
      expect(t).toMatch(/at least 15 characters, and itself a question or a request/);
      expect(t).not.toMatch(/you must not escalate/);
    });
  }
  for (const n of ["plan", "implement", "fix"]) {
    it(`${n}.md: in decide mode a large decision is written as an ADR in docs/decisions/ (C6)`, () => {
      expect(read(n)).toMatch(/write it as an ADR in `docs\/decisions\/`/);
    });
  }
  it("review.md makes a PR's own section 3 decision a finding and an escalation (C4)", () => {
    const t = read("review");
    expect(t).toContain("`rule:delivery-system-design §3`");
    expect(t).toMatch(/of kind\s+`product` or `technical` whose question is the decision the PR made/);
  });
  it("question-check.md sends an exchange the maintainer's reply asked for, judges a decide-mode blocker against the question sent back, and does not claim to read only a file (Cl6, CM2, Tm7)", () => {
    const t = read("question-check");
    expect(t).toContain("{{answer}}");
    expect(t).toMatch(/latest reply asks something back[\s\S]*return `send`/);
    expect(t).toContain("{{decide_input}}");
    expect(t).toMatch(/same\s+question as the one sent back, in any wording, return `decide_yourself`/);
    expect(t).not.toMatch(/reads only the result file/);
  });
  it("review.md never lets a product decision pass as an agent's own ADR (Cl7)", () => {
    expect(read("review")).toMatch(/a product decision never is\s+one an agent may make/);
  });
  it("question-check.md reads the issue's answered questions and words the question it sends (C8, C10)", () => {
    const t = read("question-check");
    expect(t).toContain("{{answered_questions}}");
    expect(t).toMatch(/already settles the question, return `decide_yourself` and cite it/);
    expect(t).toMatch(/On `send`, also return `question`/);
  });
  for (const n of ["plan", "review", "question-check"]) {
    it(`${n}.md says how to return the result without a write tool (T1)`, () => {
      expect(read(n)).toMatch(/If you have no tool that can write files, give the result instead as the last thing in your\s+final message/);
    });
  }
  it("review.md names all five result fields and the cited answers", () => {
    const t = read("review");
    for (const f of ["verdict", "findings_on_pr", "declined_to_judge", "escalation", "findings"]) expect(t).toContain(`"${f}"`);
    expect(t).toMatch(/exactly these five fields/);
    expect(t).toContain("{{answered_questions}}");
  });
  it("plan.md hands its questions to the spec stage", () => {
    expect(read("plan")).not.toMatch(/for the maintainer/);
  });
  it("fix.md marks a recorded ADR", () => {
    expect(read("fix")).toContain("(maintainer answer, question #");
  });
  it("spec.md marks answers, refers with Refs and never switches branches", () => {
    const t = read("spec");
    expect(t).toContain("Refs #");
    expect(t).toContain("(maintainer answer, question #");
    expect(t).toContain("docs/product-spec.md");
    expect(t).not.toMatch(/git (checkout|switch|branch)/);
    expect(t).toMatch(narrowed);
    expect(t).not.toMatch(/a user would notice/i);
    for (const m of ["write", "answer", "revise", "decide", "record"]) expect(t).toContain(`\`${m}\``);
  });
  it("spec.md records a maintainer answer in any mode, not only in record mode (AC-18)", () => {
    const t = read("spec");
    expect(t).toMatch(/Whenever a maintainer answer is present \(in any mode\),\s+write it where it belongs/);
    expect(t).toMatch(/product answer into `docs\/product-spec\.md` or the top design/);
    expect(t).toMatch(/the top designs in full, only while recording a maintainer's product answer\./);
    expect(t).not.toMatch(/in `record`\s+mode\./);
  });
  it("question-check.md quotes the narrowed rule and always sends a change to a recorded decision", () => {
    const t = read("question-check");
    expect(t).toMatch(narrowed);
    expect(t).not.toMatch(/a user would notice/i);
    expect(t).toMatch(/recorded maintainer decision.*always.*send/s);
    for (const p of ["{{question}}", "{{spec}}", "{{history}}"]) expect(t).toContain(p);
  });
  it("every committed prompt renders with a full StageInput", () => {
    for (const d of Object.values(loadStageDefinitions(`${agentsDir}/stages`))) expect(() => renderPrompt(d.prompt, full)).not.toThrow();
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
  it("renders held_work, (none) when absent, in the four stages that carry it (spec 011 AC-4)", () => {
    const read = (n: string) => readFileSync(join(agentsDir, "stages", `${n}.md`), "utf8");
    expect(renderPrompt("{{held_work}}", input)).toBe("(none)");
    expect(renderPrompt("{{held_work}}", { ...input, held_work: "Branch issue-7 is at abc" })).toBe("Branch issue-7 is at abc");
    for (const n of ["plan", "implement", "fix", "spec"]) {
      const t = read(n);
      expect(t, n).toContain("{{held_work}}");
      expect(renderPrompt(t, { ...input, held_work: "HELD-TEXT" }), n).toContain("HELD-TEXT");
      expect(renderPrompt(t, { ...input, held_work: undefined }), n).toContain("before your question, if any: (none)");
    }
    for (const n of ["implement", "fix", "spec"]) expect(read(n), n).toMatch(/Commit your work before you (escalate|return a question)/);
    expect(read("implement")).toMatch(/push to it and report its number/);
  });
  it("throws on an unknown placeholder", () => {
    expect(() => renderPrompt("{{nope}}", input)).toThrow(/unknown placeholder/);
  });
});
