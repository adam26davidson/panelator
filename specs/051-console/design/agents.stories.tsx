// Agents (spec 051 AC-12): each standing agent with last run, next run, cost over 30 days and a Pause or
// Resume control posting the change; an agent paused by the maintainer says so.
import { AGENTS, type AgentRow, Empty, type Freshness, Icon, Pending, Refused, Shell, SignIn, Skel } from "./console-kit.tsx";

export default { title: "agents" };

const COLS = ["Agent", "Last run", "Next run", "Cost, 30 days", ""];
type RowState = { pending?: "pause" | "resume"; refused?: string };

function PausedBadge({ by }: { by: string }) {
  return by === "maintainer"
    ? <span className="c-badge warn">{Icon.pause(14)} Paused by you</span>
    : <span className="c-badge">{Icon.pause(14)} Paused by {by}</span>;
}

function Control({ a, state, offline }: { a: AgentRow; state?: RowState; offline?: boolean }) {
  if (state?.pending)
    return <button type="button" className="c-btn" disabled>{state.pending === "pause" ? "Pausing…" : "Resuming…"}</button>;
  return a.paused
    ? <button type="button" className="c-btn primary" disabled={offline}>{Icon.play(16)} Resume</button>
    : <button type="button" className="c-btn" disabled={offline}>{Icon.pause(16)} Pause</button>;
}

function Row({ a, state, offline }: { a: AgentRow; state?: RowState; offline?: boolean }) {
  const last = <span style={{ color: a.lastOk ? undefined : "var(--color-danger)" }}>{a.last}</span>;
  const next = a.paused ? <span className="c-muted">— (paused)</span> : a.next;
  return (
    <li className="c-trow c-agents-grid">
      <div className="c-section" style={{ gap: 4 }}>
        <div className="c-between" style={{ alignItems: "center" }}>
          <div className="c-wrap"><span className="c-strong c-mono" style={{ fontSize: "var(--text-base)" }}>{a.name}</span>{a.paused ? <PausedBadge by={a.paused} /> : null}</div>
          <span className="c-only-narrow" style={{ flex: "none" }}><Control a={a} state={state} offline={offline} /></span>
        </div>
        <span className="c-sm c-muted">{a.summary}</span>
        <dl className="c-meta c-only-narrow" style={{ marginTop: 8 }}>
          <div className="c-kv"><dt>Last run</dt><dd>{last}</dd></div>
          <div className="c-kv"><dt>Next run</dt><dd>{next}</dd></div>
          <div className="c-kv"><dt>Cost, 30 days</dt><dd>{a.cost}</dd></div>
        </dl>
        {state?.pending ? <Pending>{state.pending === "pause" ? "Pause" : "Resume"} sent as change 58. Waiting for the scheduler to apply it.</Pending> : null}
        {state?.refused ? <Refused>{state.refused}</Refused> : null}
      </div>
      <span className="c-only-wide">{last}</span>
      <span className="c-only-wide">{next}</span>
      <span className="c-only-wide" style={{ fontVariantNumeric: "tabular-nums" }}>{a.cost}</span>
      <span className="c-only-wide" style={{ justifySelf: "end" }}><Control a={a} state={state} offline={offline} /></span>
    </li>
  );
}

function Agents({ fresh = "fresh", states = {} }: { fresh?: Freshness; states?: Record<string, RowState> }) {
  return (
    <Shell screen="agents" fresh={fresh}>
      <p className="c-muted c-sm">Standing agents run on their schedules and on events. A pause you set holds until you resume; an agent cannot resume what you paused.</p>
      <div className="c-card c-tbody">
        <div className="c-thead c-agents-grid" aria-hidden="true">{COLS.map((c) => <span key={c}>{c}</span>)}</div>
        <ul>{AGENTS.map((a) => <Row key={a.name} a={a} state={states[a.name]} offline={fresh === "offline"} />)}</ul>
      </div>
    </Shell>
  );
}

export const Default = () => <Agents />;
/** Pause pressed on findings-filer: queued, outcome not yet back. */
export const PendingChange = () => <Agents states={{ "findings-filer": { pending: "pause" } }} />;
/** Resume of reflection refused by the scheduler; the reason is shown and the agent stays paused. */
export const RefusedChange = () => (
  <Agents states={{ reflection: { refused: "Resume refused: agent reflection is not in the registry any more (removed in PR #207)." } }} />
);
export const Loading = () => (
  <Shell screen="agents" fresh="loading" openQuestions={0}>
    <div className="c-card c-section" aria-busy="true">{[0, 1, 2].map((k) => <Skel key={k} h={72} />)}</div>
  </Shell>
);
export const Stale = () => <Agents fresh="stale" />;
export const Unreachable = () => <Agents fresh="offline" />;
export const SignedOut = () => <SignIn screen="agents" />;
export const Empty_ = () => (
  <Shell screen="agents">
    <Empty icon={Icon.bot(24)} title="No standing agents">
      No standing agent is registered. When a PR adds one under agents/standing/, it appears here with its schedule and a Pause control.
    </Empty>
  </Shell>
);
Empty_.storyName = "Empty";
