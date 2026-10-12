import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityGate, automationChangeGate, fixLoopGate, isSensitive, latestLabelActor, livenessGate,
  readyGate, scopeGate, specPresentGate, uiDesignGate, validatedGate,
} from "../src/gates/index.ts";
import { parseSpec } from "../src/spec/parse.ts";
import type { IssueData, LabelEvent, PlanResult } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const ME = "adam26davidson";
const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "specs", n), "utf8");

function issue(over: Partial<IssueData> = {}): IssueData {
  return {
    number: 5, title: "t", author: BOT, body: "Spec: specs/010-thing/spec.md", labels: ["validated"],
    labelEvents: [{ label: "validated", actor: BOT, action: "labeled", at: "2026-10-01T00:00:00Z" }],
    createdAt: "2026-10-01T00:00:00Z", ...over,
  };
}
const ev = (label: string, actor: string, action: LabelEvent["action"], at: string): LabelEvent => ({ label, actor, action, at });

describe("latestLabelActor", () => {
  it("returns the actor of the most recent add, ignoring an earlier add that was removed (review focus 3)", () => {
    const events = [ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2"), ev("validated", BOT, "labeled", "3")];
    expect(latestLabelActor(events, "validated")).toBe(BOT);
  });
  it("returns null when the label was removed last", () => {
    expect(latestLabelActor([ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2")], "validated")).toBeNull();
  });
});

describe("authorityGate (AC-6, section 4.3)", () => {
  it("passes a bot-authored issue", () => {
    expect(authorityGate(issue(), BOT, ME, "validated")).toEqual({ ok: true });
  });
  it("passes a maintainer-authored issue when the maintainer added validated", () => {
    const i = issue({ author: ME, labelEvents: [ev("validated", ME, "labeled", "1")] });
    expect(authorityGate(i, BOT, ME, "validated").ok).toBe(true);
  });
  it("ignores a community issue even with validated added by someone else", () => {
    const i = issue({ author: "stranger", labelEvents: [ev("validated", "stranger", "labeled", "1")] });
    const r = authorityGate(i, BOT, ME, "validated");
    expect(r).toEqual({ ok: false, action: "ignore", reason: expect.stringMatching(/authority/) });
  });
});

describe("validatedGate (AC-6)", () => {
  it("ignores without the label and never labels", () => {
    expect(validatedGate(issue({ labels: [] }), "validated")).toEqual({ ok: false, action: "ignore", reason: expect.any(String) });
  });
  it("passes with it", () => {
    expect(validatedGate(issue(), "validated").ok).toBe(true);
  });
});

describe("specPresentGate (AC-7)", () => {
  it("labels needs-spec when the body has no link", () => {
    const r = specPresentGate(issue({ body: "hi" }), null);
    expect(r).toMatchObject({ ok: false, action: "label", label: "needs-spec" });
  });
  it("labels needs-spec naming the missing part when the file is absent on main", () => {
    const r = specPresentGate(issue(), null);
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/not found on main/) });
  });
  it("labels needs-spec naming open decisions", () => {
    const r = specPresentGate(issue(), fx("open-decisions.md"));
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Open decisions/) });
  });
  it("passes a complete spec", () => {
    expect(specPresentGate(issue(), fx("good-backend.md"))).toEqual({ ok: true });
  });
});

describe("uiDesignGate (AC-8)", () => {
  const web = parseSpec(fx("good-webui.md"));
  it("passes a non-UI domain with no design dir", () => {
    expect(uiDesignGate(parseSpec(fx("good-backend.md")), [])).toEqual({ ok: true });
  });
  it("labels needs-design on an empty design dir", () => {
    expect(uiDesignGate(web, [])).toMatchObject({ ok: false, label: "needs-design" });
  });
  it("requires a story or token prototype and a PNG per screen", () => {
    expect(uiDesignGate(web, ["editor.stories.tsx", "editor-empty.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/editor-populated\.png/) });
    expect(uiDesignGate(web, ["editor-empty.png", "editor-populated.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/story or token prototype/) });
    expect(uiDesignGate(web, ["tokens.html", "editor-empty.png", "editor-populated.png"])).toEqual({ ok: true });
  });
});

describe("automationChangeGate (AC-12)", () => {
  const spec001 = parseSpec(readFileSync(join(import.meta.dirname, "..", "..", "..", "specs", "001-scheduler-core", "spec.md"), "utf8"));
  it("ignores when validated was set by the bot", () => {
    expect(automationChangeGate(issue(), spec001, ME, "validated")).toMatchObject({ ok: false, action: "ignore" });
  });
  it("passes when validated was set by the maintainer", () => {
    expect(automationChangeGate(issue({ labelEvents: [ev("validated", ME, "labeled", "1")] }), spec001, ME, "validated")).toEqual({ ok: true });
  });
  it("passes a non-automation spec regardless", () => {
    expect(automationChangeGate(issue(), parseSpec(fx("good-backend.md")), ME, "validated")).toEqual({ ok: true });
  });
  it("detects a spec listing a parent directory of the automation paths", () => {
    const s = parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `tools/`"));
    expect(automationChangeGate(issue(), s, ME, "validated")).toMatchObject({ ok: false, action: "ignore" });
    expect(automationChangeGate(issue({ labelEvents: [ev("validated", ME, "labeled", "1")] }), s, ME, "validated")).toEqual({ ok: true });
  });
});

describe("readyGate (AC-9)", () => {
  it("labels needs-clarification on spec_gap with the questions in the reason", () => {
    const r = readyGate({ verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which port?", "Which db?"] });
    expect(r).toMatchObject({ ok: false, label: "needs-clarification", reason: expect.stringContaining("Which db?") });
  });
  it("passes ready", () => {
    expect(readyGate({ verdict: "ready", domain: "backend", tasks: [] })).toEqual({ ok: true });
  });
});

describe("scopeGate (AC-10) and isSensitive (AC-11)", () => {
  const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["backend/a.rs", "backend/auth/x.rs"] }] };
  const spec = parseSpec(fx("good-backend.md"));
  const globs = ["backend/**/auth/**", "tools/scheduler/"];
  it("passes a diff inside the plan plus lockfiles and schemas", () => {
    expect(scopeGate(["backend/a.rs", "pnpm-lock.yaml", "Cargo.lock", "schemas/x.json"], plan, spec, globs)).toEqual({ ok: true });
  });
  it("lists files outside scope", () => {
    expect(scopeGate(["backend/a.rs", "web/x.ts"], plan, spec, globs)).toEqual({ ok: false, violations: ["web/x.ts: outside plan file scope"] });
  });
  it("fails a sensitive file not listed in the spec even when it is in the plan (review focus 4)", () => {
    expect(scopeGate(["backend/auth/x.rs"], plan, spec, globs)).toEqual({ ok: false, violations: ["backend/auth/x.rs: sensitive path not listed in the spec"] });
  });
  it("allows a sensitive file the spec lists", () => {
    const s = parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `backend/auth/`"));
    expect(scopeGate(["backend/auth/x.rs"], plan, s, globs)).toEqual({ ok: true });
  });
  it("treats a plan directory entry as a prefix", () => {
    const p: PlanResult = { ...plan, tasks: [{ id: "T1", description: "d", files: ["tools/scheduler/src/"] }] };
    expect(scopeGate(["tools/scheduler/src/x.ts"], p, parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `tools/scheduler/`")), globs)).toEqual({ ok: true });
  });
  it("isSensitive returns the matching paths", () => {
    expect(isSensitive(["web/a.ts", "tools/scheduler/src/x.ts"], globs)).toEqual(["tools/scheduler/src/x.ts"]);
  });
});

describe("fixLoopGate (AC-13)", () => {
  it("passes 0 and 1, labels needs-human at 2", () => {
    expect(fixLoopGate(0).ok).toBe(true);
    expect(fixLoopGate(1).ok).toBe(true);
    expect(fixLoopGate(2)).toMatchObject({ ok: false, label: "needs-human" });
  });
});

describe("livenessGate (AC-15)", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("passes while a run is in flight regardless of age", () => {
    expect(livenessGate("2026-10-12T00:00:00Z", true, now, 2).ok).toBe(true);
  });
  it("passes with recent activity", () => {
    expect(livenessGate("2026-10-12T11:00:00Z", false, now, 2).ok).toBe(true);
  });
  it("expires after the window with no run", () => {
    expect(livenessGate("2026-10-12T09:59:00Z", false, now, 2)).toMatchObject({ ok: false, action: "ignore", reason: expect.stringMatching(/liveness/) });
  });
});
