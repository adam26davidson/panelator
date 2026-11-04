import { readJsonLines } from "../filer/input.ts";
import type { LogEntry } from "../actions/log.ts";
import type { StatePaths } from "../state/paths.ts";
import { listAgentStates, type StandingEvent } from "./state.ts";

const DAY = 86_400_000;

/** Spec 030 AC-15: read-only evidence for the sweep: pending events, agent states, 24h of tick summaries, 7d of actions. */
export async function buildInfraHealthInput(paths: StatePaths, events: StandingEvent[], now: Date) {
  const states = await listAgentStates(paths);
  const service = await readJsonLines<{ at: string; kind: string }>(paths.serviceLog);
  const tickKinds = ["tick", "restart", "stopped", "infra", "standing-error"];
  return {
    events,
    agents: Object.entries(states).map(([name, s]) => ({ name, failures: s.failures, paused: s.paused, paused_by: s.paused_by, last_run: s.last_run, summary: s.summary ?? null })),
    tick_summaries: service.filter((r) => tickKinds.includes(r.kind) && now.getTime() - Date.parse(r.at) <= DAY).slice(-300),
    actions: (await readJsonLines<LogEntry>(paths.actionsLog)).filter((r) => now.getTime() - Date.parse(r.at) <= 7 * DAY),
  };
}
