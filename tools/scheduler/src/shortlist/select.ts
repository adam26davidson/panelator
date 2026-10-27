import { CLAIM_LABEL, SECURITY_REVIEW_LABEL } from "../chain/machine.ts";
import type { Config } from "../config.ts";
import {
  authorityGate, specPresentGate, uiDesignGate, validatedGate, VALIDATED_LABEL, type GateResult,
} from "../gates/index.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";

export interface SelectContext {
  appBot: string;
  maintainer: string;
  labels: Config["labels"];
  claimed: Set<number>;
  /** Reads any repo-relative file on main (specs and their parent designs); null when absent. */
  readSpec: (path: string) => string | null;
  listDesign: (specPath: string) => string[];
}

export interface Decision {
  issue: number;
  gate: string;
  result: GateResult;
}

const SKIP_PREFIX = "needs-";
const BLOCKED = "blocked";
const ABANDONED = "abandoned";

export function selectEligible(issues: IssueData[], ctx: SelectContext): { eligible: IssueData[]; decisions: Decision[] } {
  const eligible: IssueData[] = [];
  const decisions: Decision[] = [];
  for (const issue of issues) {
    if (ctx.claimed.has(issue.number)) continue;
    if (issue.labels.includes(CLAIM_LABEL) || issue.labels.includes(BLOCKED) || issue.labels.includes(ABANDONED) || issue.labels.includes(SECURITY_REVIEW_LABEL) || issue.labels.some((l) => l.startsWith(SKIP_PREFIX))) continue;

    const steps: [string, () => GateResult][] = [
      ["authority", () => authorityGate(issue, ctx.appBot, ctx.maintainer, VALIDATED_LABEL)],
      ["validated", () => validatedGate(issue, VALIDATED_LABEL)],
      ["spec-present", () => specPresentGate(issue, specText(issue, ctx), ctx.readSpec)],
      ["ui-design", () => uiDesignGate(parsedSpec(issue, ctx), ctx.listDesign(specPathFromIssueBody(issue.body) ?? ""))],
    ];
    let failed = false;
    for (const [gate, run] of steps) {
      const result = run();
      if (!result.ok) {
        decisions.push({ issue: issue.number, gate, result });
        failed = true;
        break;
      }
    }
    if (!failed) {
      decisions.push({ issue: issue.number, gate: "eligible", result: { ok: true } });
      eligible.push(issue);
    }
  }
  return { eligible, decisions };
}

function specText(issue: IssueData, ctx: SelectContext): string | null {
  const p = specPathFromIssueBody(issue.body);
  return p ? ctx.readSpec(p) : null;
}

function parsedSpec(issue: IssueData, ctx: SelectContext) {
  // Only reached after specPresentGate passed, so the text exists and parses clean.
  return parseSpec(specText(issue, ctx) ?? "");
}
