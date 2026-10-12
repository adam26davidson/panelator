import type { IssueData, LabelEvent } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

/** Actor of the most recent add of `label`, or null if it is not currently applied by the timeline. */
export function latestLabelActor(events: LabelEvent[], label: string): string | null {
  let actor: string | null = null;
  for (const e of events) {
    if (e.label !== label) continue;
    actor = e.action === "labeled" ? e.actor : null;
  }
  return actor;
}

export function authorityGate(issue: IssueData, appBot: string, maintainer: string, validatedLabel: string): GateResult {
  if (issue.author === appBot) return pass;
  if (latestLabelActor(issue.labelEvents, validatedLabel) === maintainer) return pass;
  return ignore(`authority: author ${issue.author} is not the App and ${validatedLabel} was not set by the maintainer`);
}
