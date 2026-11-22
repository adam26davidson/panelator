import { useChange, useConsole } from "../../app/ConsoleProvider.tsx";
import { Screen } from "../../app/layout/Shell.tsx";
import { Pending, Refused } from "../../features/changes/ChangeOutcome.tsx";
import type { Agent } from "../../shared/api/types.ts";
import { usd, when } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { Empty, Skel } from "../../shared/ui/parts.tsx";

const COLS = ["Agent", "Last run", "Next run", "Cost, 30 days", ""];

function PausedBadge({ by }: { by: string | null }) {
  return by === "maintainer" ? (
    <span className="c-badge warn">{Icon.pause(14)} Paused by you</span>
  ) : (
    <span className="c-badge">
      {Icon.pause(14)} Paused{by ? ` by ${by}` : ""}
    </span>
  );
}

function Row({ a }: { a: Agent }) {
  const { send, view } = useConsole();
  const offline = view.fresh === "offline";
  const { pending, outcome } = useChange(
    (c) => (c.kind === "pause_agent" || c.kind === "resume_agent") && c.args.name === a.name,
  );
  const refusal = outcome?.status === "refused" ? (outcome.reason ?? "refused") : null;
  const post = () => void send(a.paused ? "resume_agent" : "pause_agent", { name: a.name }).catch(() => undefined);
  const control = pending ? (
    <button type="button" className="c-btn" disabled>
      {pending.kind === "pause_agent" ? "Pausing…" : "Resuming…"}
    </button>
  ) : a.paused ? (
    <button type="button" className="c-btn primary" disabled={offline} onClick={post}>
      {Icon.play(16)} Resume
    </button>
  ) : (
    <button type="button" className="c-btn" disabled={offline} onClick={post}>
      {Icon.pause(16)} Pause
    </button>
  );
  const last = a.last_run ? (
    <span style={{ color: a.last_run.outcome === "ok" ? undefined : "var(--color-danger)" }}>
      {when(a.last_run.at)} · {a.last_run.outcome === "ok" ? "ok" : "failed"}
    </span>
  ) : (
    when(null)
  );
  const next = a.paused ? <span className="c-muted">— (paused)</span> : when(a.next_run);
  return (
    <li className="c-trow c-agents-grid">
      <div className="c-section" style={{ gap: 4 }}>
        <div className="c-between" style={{ alignItems: "center" }}>
          <div className="c-wrap">
            <span className="c-strong c-mono" style={{ fontSize: "var(--text-base)" }}>
              {a.name}
            </span>
            {a.paused ? <PausedBadge by={a.paused_by} /> : null}
          </div>
          <span className="c-only-narrow" style={{ flex: "none" }}>
            {control}
          </span>
        </div>
        {a.summary ? <span className="c-sm c-muted">{a.summary}</span> : null}
        <dl className="c-meta c-only-narrow" style={{ marginTop: 8 }}>
          <div className="c-kv">
            <dt>Last run</dt>
            <dd>{last}</dd>
          </div>
          <div className="c-kv">
            <dt>Next run</dt>
            <dd>{next}</dd>
          </div>
          <div className="c-kv">
            <dt>Cost, 30 days</dt>
            <dd>{usd(a.cost_30d_usd)}</dd>
          </div>
        </dl>
        {pending ? (
          <Pending>
            {pending.kind === "pause_agent" ? "Pause" : "Resume"} sent as change {pending.id}. Waiting for the scheduler
            to apply it.
          </Pending>
        ) : null}
        {refusal ? (
          <Refused>
            {outcome?.kind === "pause_agent" ? "Pause" : "Resume"} refused: {refusal}
          </Refused>
        ) : null}
      </div>
      <span className="c-only-wide">{last}</span>
      <span className="c-only-wide">{next}</span>
      <span className="c-only-wide" style={{ fontVariantNumeric: "tabular-nums" }}>
        {usd(a.cost_30d_usd)}
      </span>
      <span className="c-only-wide" style={{ justifySelf: "end" }}>
        {control}
      </span>
    </li>
  );
}

export function Agents() {
  return (
    <Screen
      screen="agents"
      skeleton={
        <div className="c-card c-section" aria-busy="true">
          {[0, 1, 2].map((k) => (
            <Skel key={k} h={72} />
          ))}
        </div>
      }
    >
      {(s) =>
        s.agents.length === 0 ? (
          <Empty icon={Icon.bot(24)} title="No standing agents">
            No standing agent is registered. When a PR adds one under agents/standing/, it appears here with its
            schedule and a Pause control.
          </Empty>
        ) : (
          <>
            <p className="c-muted c-sm">
              Standing agents run on their schedules and on events. A pause you set holds until you resume; an agent
              cannot resume what you paused.
            </p>
            <div className="c-card c-tbody">
              <div className="c-thead c-agents-grid" aria-hidden="true">
                {COLS.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <ul>
                {s.agents.map((a) => (
                  <Row key={a.name} a={a} />
                ))}
              </ul>
            </div>
          </>
        )
      }
    </Screen>
  );
}
