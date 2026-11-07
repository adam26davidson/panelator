// Actions (spec 051 AC-11): the action log newest first with what, why, agent, when and status, and an Undo
// control when the entry has an undo and is applied. Undo posts an `undo` change; the row shows it pending
// until the change's outcome arrives, then the outcome.
import { ACTIONS, type ActionRow, Empty, type Freshness, Icon, Pending, Refused, Shell, SignIn, Skel } from "./console-kit.tsx";

export default { title: "actions" };

const TONE: Record<ActionRow["status"], string> = { applied: "ok", undone: "", refused: "danger", failed: "danger", pending: "accent" };
const COLS = ["When", "What and why", "Agent", "Status", ""];

type RowState = { pending?: boolean; refused?: string };

function Row({ a, state, offline }: { a: ActionRow; state?: RowState; offline?: boolean }) {
  const status = state?.pending ? <span className="c-badge accent"><span className="c-spin" />Undo pending</span>
    : <span className={`c-badge ${TONE[a.status]}`}>{a.status}</span>;
  const canUndo = a.undoable && a.status === "applied";
  const undo = canUndo ? (
    <button type="button" className="c-btn" disabled={offline || state?.pending} aria-label={`Undo: ${a.what}`}>
      {state?.pending ? "Undoing…" : <>{Icon.undo(16)} Undo</>}
    </button>
  ) : null;
  return (
    <li className="c-trow c-actions-grid">
      <span className="c-sm c-muted c-only-wide" style={{ paddingTop: 2 }}>{a.when}</span>
      <div className="c-section" style={{ gap: 4 }}>
        <div className="c-wrap c-only-narrow"><span className="c-sm c-muted">{a.when}</span><span className="c-sm c-muted">·</span><span className="c-sm c-strong">{a.agent}</span></div>
        <span className="c-strong">{a.what}</span>
        <span className="c-sm c-muted">{a.why}</span>
        {a.reason ? <span className="c-sm" style={{ color: "var(--color-danger)" }}>Refused: {a.reason}</span> : null}
        {state?.pending ? <Pending>Undo sent as change 57 at 10:44:12. Waiting for the scheduler to apply it.</Pending> : null}
        {state?.refused ? <Refused>Undo refused: {state.refused}</Refused> : null}
        <div className="c-wrap c-only-narrow" style={{ justifyContent: "space-between", marginTop: 4 }}>{status}{undo}</div>
      </div>
      <span className="c-sm c-only-wide c-ellipsis" style={{ paddingTop: 2 }}>{a.agent === "maintainer" ? "you (maintainer)" : a.agent}</span>
      <span className="c-only-wide">{status}</span>
      <span className="c-only-wide" style={{ justifySelf: "end" }}>{undo}</span>
    </li>
  );
}

function Actions({ fresh = "fresh", states = {} }: { fresh?: Freshness; states?: Record<string, RowState> }) {
  return (
    <Shell screen="actions" fresh={fresh}>
      <p className="c-muted c-sm">What the system did on its own, and what you changed, newest first. Showing the last 200.</p>
      <div className="c-card c-tbody">
        <div className="c-thead c-actions-grid" aria-hidden="true">{COLS.map((c) => <span key={c}>{c}</span>)}</div>
        <ul>{ACTIONS.map((a) => <Row key={a.id} a={a} state={states[a.id]} offline={fresh === "offline"} />)}</ul>
      </div>
    </Shell>
  );
}

export const Default = () => <Actions />;
/** Undo pressed on the newest entry: the change is queued and its outcome has not arrived. */
export const PendingChange = () => <Actions states={{ "a-0193": { pending: true } }} />;
/** The scheduler refused an undo: the reason is shown on the entry, which stays applied. */
export const RefusedChange = () => (
  <Actions states={{ "a-0192": { refused: "reflection was resumed after this pause, so there is nothing to undo." } }} />
);
export const Loading = () => (
  <Shell screen="actions" fresh="loading" openQuestions={0}>
    <div className="c-card c-section" aria-busy="true">{[0, 1, 2, 3, 4].map((k) => <Skel key={k} h={56} />)}</div>
  </Shell>
);
export const Stale = () => <Actions fresh="stale" />;
export const Unreachable = () => <Actions fresh="offline" />;
export const SignedOut = () => <SignIn screen="actions" />;
export const Empty_ = () => (
  <Shell screen="actions">
    <Empty icon={Icon.list(24)} title="No actions yet">
      Nothing has been changed by an agent or from this console. Each action appears here with its reason, and Undo when it can be reversed.
    </Empty>
  </Shell>
);
Empty_.storyName = "Empty";
