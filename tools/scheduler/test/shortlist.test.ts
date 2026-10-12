import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rankIssues } from "../src/shortlist/rank.ts";
import { selectEligible } from "../src/shortlist/select.ts";
import type { IssueData } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const ME = "adam26davidson";
const labels = { priority: "priority", feature_classes: ["class:product"], debt_classes: ["class:bug", "class:tooling", "class:dependency"] };
const good = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");

function issue(n: number, over: Partial<IssueData> = {}): IssueData {
  return {
    number: n, title: `i${n}`, author: BOT, body: "Spec: specs/010-thing/spec.md", labels: ["validated", "class:product"],
    labelEvents: [{ label: "validated", actor: BOT, action: "labeled", at: "2026-10-01T00:00:00Z" }],
    createdAt: `2026-10-0${n}T00:00:00Z`, ...over,
  };
}

describe("rankIssues", () => {
  it("puts priority first, then the class behind the 2:1 ratio, then oldest", () => {
    const a = issue(1, { labels: ["validated", "class:bug"] });
    const b = issue(2, { labels: ["validated", "class:product"] });
    const c = issue(3, { labels: ["validated", "class:product", "priority"] });
    const d = issue(4, { labels: ["validated", "class:product"] });
    // 2 features and 0 debt merged recently: debt is behind, so bug comes before products
    expect(rankIssues([a, b, c, d], labels, { feature: 2, debt: 0 }).map((i) => i.number)).toEqual([3, 1, 2, 4]);
    // 0 and 0: feature first
    expect(rankIssues([a, b, c, d], labels, { feature: 0, debt: 0 }).map((i) => i.number)).toEqual([3, 2, 4, 1]);
  });
});

describe("selectEligible", () => {
  const ctx = {
    appBot: BOT, maintainer: ME, labels, claimed: new Set<number>(),
    readSpec: (p: string) => (p === "specs/010-thing/spec.md" ? good : null),
    listDesign: () => [],
  };
  it("returns eligible issues and a decision per failed gate", () => {
    const ok = issue(1);
    const noLabel = issue(2, { labels: [] });
    const badSpec = issue(3, { body: "Spec: specs/999-none/spec.md" });
    const claimed = issue(4);
    const blocked = issue(5, { labels: ["validated", "blocked"] });
    const needs = issue(6, { labels: ["validated", "needs-human"] });
    const r = selectEligible([ok, noLabel, badSpec, claimed, blocked, needs], { ...ctx, claimed: new Set([4]) });
    expect(r.eligible.map((i) => i.number)).toEqual([1]);
    expect(r.decisions.find((d) => d.issue === 3)).toMatchObject({ gate: "spec-present", result: { ok: false, label: "needs-spec" } });
    expect(r.decisions.find((d) => d.issue === 2)).toMatchObject({ gate: "validated", result: { action: "ignore" } });
    expect(r.decisions.filter((d) => d.issue === 4)).toEqual([]);
    expect(r.decisions.filter((d) => d.issue === 5)).toEqual([]);
    expect(r.decisions.filter((d) => d.issue === 6)).toEqual([]);
  });
  it("skips an issue labelled security-review like blocked: neither eligible nor decided (AC-11)", () => {
    const sec = issue(7, { labels: ["validated", "class:product", "security-review"] });
    const r = selectEligible([sec], ctx);
    expect(r.eligible).toEqual([]);
    expect(r.decisions).toEqual([]);
  });
  it("stops at the first failing gate per issue", () => {
    const r = selectEligible([issue(9, { author: "stranger", labels: [] })], ctx);
    expect(r.decisions.filter((d) => d.issue === 9)).toHaveLength(1);
    expect(r.decisions[0].gate).toBe("authority");
  });
});
