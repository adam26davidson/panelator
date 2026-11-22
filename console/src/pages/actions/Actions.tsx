import { useChange, useConsole } from "../../app/ConsoleProvider.tsx";
import { Screen } from "../../app/layout/Shell.tsx";
import { Pending, Refused } from "../../features/changes/ChangeOutcome.tsx";
import type { ActionEntry } from "../../shared/api/types.ts";
import { clock, when } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { Empty, Skel } from "../../shared/ui/parts.tsx";

const TONE: Record<ActionEntry["status"], string> = {
  applied: "ok",
  undone: "",
  refused: "danger",
  failed: "danger",
  pending: "accent",
};
const COLS = ["When", "What and why", "Agent", "Status", ""];

/** One line saying what the action did, from its kind and arguments. */
function describe(a: ActionEntry): string {
  const n = a.args.name;
  if (a.kind === "set_parameter") return `Set ${String(n)} to ${JSON.stringify(a.args.value)}`;
  if (a.kind === "pause_agent") return `Pause agent ${String(n)}`;
  if (a.kind === "resume_agent") return `Resume agent ${String(n)}`;
  if (a.kind === "undo") return `Undo action ${String(a.args.action_id)}`;
  return `${a.kind} ${JSON.stringify(a.args)}`;
}

function Row({ a }: { a: ActionEntry }) {
  const { send, view } = useConsole();
  const offline = view.fresh === "offline";
  const { pending, outcome } = useChange((c) => c.kind === "undo" && c.args.action_id === a.id);
  const refusal = outcome?.status === "refused" ? (outcome.reason ?? "refused") : null;
  const status = pending ? (
    <span className="c-badge accent">
      <span className="c-spin" />
      Undo pending
    </span>
  ) : (
    <span className={`c-badge ${TONE[a.status]}`}>{a.status}</span>
  );
  const canUndo = a.undo !== null && a.status === "applied";
  const undo = canUndo ? (
    <button
      type="button"
      className="c-btn"
      disabled={offline || !!pending}
      aria-label={`Undo: ${describe(a)}`}
      onClick={() => void send("undo", { action_id: a.id }).catch(() => undefined)}
    >
      {pending ? "Undoing…" : <>{Icon.undo(16)} Undo</>}
    </button>
  ) : null;
  const who = a.agent === "maintainer" ? "you (maintainer)" : a.agent;
  return (
    <li className="c-trow c-actions-grid">
      <span className="c-sm c-muted c-only-wide" style={{ paddingTop: 2 }}>
        {when(a.at)}
      </span>
      <div className="c-section" style={{ gap: 4 }}>
        <div className="c-wrap c-only-narrow">
          <span className="c-sm c-muted">{when(a.at)}</span>
          <span className="c-sm c-muted">·</span>
          <span className="c-sm c-strong">{who}</span>
        </div>
        <span className="c-strong">{describe(a)}</span>
        <span className="c-sm c-muted">{a.why}</span>
        {a.reason ? (
          <span className="c-sm" style={{ color: "var(--color-danger)" }}>
            Refused: {a.reason}
          </span>
        ) : null}
        {pending ? (
          <Pending>
            Undo sent as change {pending.id} at {clock(pending.at)}. Waiting for the scheduler to apply it.
          </Pending>
        ) : null}
        {refusal ? <Refused>Undo refused: {refusal}</Refused> : null}
        <div className="c-wrap c-only-narrow" style={{ justifyContent: "space-between", marginTop: 4 }}>
          {status}
          {undo}
        </div>
      </div>
      <span className="c-sm c-only-wide c-ellipsis" style={{ paddingTop: 2 }}>
        {who}
      </span>
      <span className="c-only-wide">{status}</span>
      <span className="c-only-wide" style={{ justifySelf: "end" }}>
        {undo}
      </span>
    </li>
  );
}

export function Actions() {
  return (
    <Screen
      screen="actions"
      skeleton={
        <div className="c-card c-section" aria-busy="true">
          {[0, 1, 2, 3, 4].map((k) => (
            <Skel key={k} h={56} />
          ))}
        </div>
      }
    >
      {(s) =>
        s.actions.length === 0 ? (
          <Empty icon={Icon.list(24)} title="No actions yet">
            Nothing has been changed by an agent or from this console. Each action appears here with its reason, and
            Undo when it can be reversed.
          </Empty>
        ) : (
          <>
            <p className="c-muted c-sm">
              What the system did on its own, and what you changed, newest first. Showing the last 200.
            </p>
            <div className="c-card c-tbody">
              <div className="c-thead c-actions-grid" aria-hidden="true">
                {COLS.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <ul>
                {[...s.actions]
                  .sort((x, y) => y.at.localeCompare(x.at))
                  .map((a) => (
                    <Row key={a.id} a={a} />
                  ))}
              </ul>
            </div>
          </>
        )
      }
    </Screen>
  );
}
