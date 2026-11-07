// Parameters (spec 051 AC-13): each parameter with its description, value, limits and an auto / locked
// switch. A value edit posts set_parameter; the switch posts set_parameter_mode. Locked means the system
// cannot change it; the maintainer can. A pending change shows until its outcome; a refusal shows its reason.
import { Empty, type Freshness, Icon, PARAMS, type ParamRow, Pending, Refused, Shell, SignIn, Skel } from "./console-kit.tsx";

export default { title: "parameters" };

const COLS = ["Parameter", "Value", "Mode", "Last set"];
type RowState = { edit?: string; pendingValue?: string; pendingMode?: "auto" | "locked"; refused?: string; focus?: boolean };

function limits(p: ParamRow) {
  if (p.min === undefined && p.max === undefined) return p.type === "boolean" ? "on or off" : p.type;
  return [p.min !== undefined ? `min ${p.min}` : null, p.max !== undefined ? `max ${p.max}` : null].filter(Boolean).join(" · ");
}

function ValueControl({ p, s, offline }: { p: ParamRow; s?: RowState; offline?: boolean }) {
  if (p.type === "boolean")
    return (
      <div className="c-seg-ctl" role="group" aria-label={`${p.name} value`}>
        <button type="button" aria-pressed={p.value === "true"} disabled={offline}>On</button>
        <button type="button" aria-pressed={p.value !== "true"} disabled={offline}>Off</button>
      </div>
    );
  const shown = s?.pendingValue ?? s?.edit ?? p.value;
  const cls = s?.refused ? " bad" : s?.edit ? " edited" : "";
  return (
    <div className="c-field">
      <input className={`c-input${p.type === "string" ? " wide" : ""}${cls}`} value={shown} readOnly={offline || !!s?.pendingValue} aria-label={`${p.name} value`} onChange={() => undefined} />
      {s?.edit && !s.refused ? <button type="button" className="c-btn primary">Save</button> : null}
    </div>
  );
}

function ModeSwitch({ p, s, offline }: { p: ParamRow; s?: RowState; offline?: boolean }) {
  const mode = s?.pendingMode ?? p.mode;
  return (
    <div className="c-seg-ctl" role="group" aria-label={`${p.name} mode`}>
      <button type="button" className="auto" aria-pressed={mode === "auto"} disabled={offline}>Auto</button>
      <button type="button" className="locked" aria-pressed={mode === "locked"} disabled={offline}>{Icon.lock(14)} Locked</button>
    </div>
  );
}

function Row({ p, s, offline }: { p: ParamRow; s?: RowState; offline?: boolean }) {
  const lastSet = <span className="c-sm c-muted">{p.setBy === "maintainer" ? "you" : p.setBy}, {p.at}</span>;
  const lockedNote = p.mode === "locked" && !s?.pendingMode
    ? <div className="c-note locked" style={{ padding: "6px 10px" }}>{Icon.lock(16)}<span>Locked: the system cannot change this. You can.</span></div>
    : null;
  return (
    <li className={`c-trow c-params-grid${s?.focus ? " c-focus" : ""}`} id={`parameters-${p.name}`}>
      <div className="c-section" style={{ gap: 4 }}>
        <span className="c-strong c-mono" style={{ fontSize: "var(--text-base)", wordBreak: "break-word" }}>{p.name}</span>
        <span className="c-sm c-muted">{p.description}</span>
        <span className="c-sm c-only-wide">{limits(p)}</span>
      </div>
      <div className="c-section" style={{ gap: 8 }}>
        <div className="c-wrap c-only-narrow c-sm c-muted" style={{ justifyContent: "space-between" }}><span>Value · {limits(p)}</span></div>
        <ValueControl p={p} s={s} offline={offline} />
        {s?.pendingValue ? <Pending>Set to {s.pendingValue}, sent as change 59. Waiting for the scheduler.</Pending> : null}
        {s?.refused ? <Refused>{s.refused}</Refused> : null}
      </div>
      <div className="c-section" style={{ gap: 8 }}>
        <span className="c-sm c-muted c-only-narrow">Mode</span>
        <ModeSwitch p={p} s={s} offline={offline} />
        {s?.pendingMode ? <Pending>Mode set to {s.pendingMode}, sent as change 60. Waiting for the scheduler.</Pending> : lockedNote}
      </div>
      <div className="c-section" style={{ gap: 2 }}>
        <span className="c-sm c-muted c-only-narrow">Last set</span>
        {lastSet}
      </div>
    </li>
  );
}

function Parameters({ fresh = "fresh", states = {} }: { fresh?: Freshness; states?: Record<string, RowState> }) {
  return (
    <Shell screen="parameters" fresh={fresh}>
      <p className="c-muted c-sm">
        <b>Auto</b>: agents may change the value within its limits. <b>Locked</b>: only you can change it. Every change is applied by the scheduler as you, the maintainer.
      </p>
      <div className="c-card c-tbody">
        <div className="c-thead c-params-grid" aria-hidden="true">{COLS.map((c) => <span key={c}>{c}</span>)}</div>
        <ul>{PARAMS.map((p) => <Row key={p.name} p={p} s={states[p.name]} offline={fresh === "offline"} />)}</ul>
      </div>
    </Shell>
  );
}

export const Default = () => <Parameters />;
/** Opened from Home's AWS tile: aws_cap_usd is scrolled into view and outlined, the value being edited. */
export const FromAwsTile = () => <Parameters states={{ aws_cap_usd: { focus: true, edit: "5" } }} />;
/** A value change and a mode change both queued, outcomes not yet back. */
export const PendingChange = () => <Parameters states={{ slots: { pendingValue: "3" }, system_work_share: { pendingMode: "locked" } }} />;
/** A value the definition refuses: the reason is shown and the stored value is unchanged. */
export const RefusedChange = () => (
  <Parameters states={{ slots: { edit: "6", refused: "Refused: 6 is above the maximum of 4. The value stays 2." } }} />
);
export const Loading = () => (
  <Shell screen="parameters" fresh="loading" openQuestions={0}>
    <div className="c-card c-section" aria-busy="true">{[0, 1, 2, 3, 4].map((k) => <Skel key={k} h={72} />)}</div>
  </Shell>
);
export const Stale = () => <Parameters fresh="stale" />;
export const Unreachable = () => <Parameters fresh="offline" />;
export const SignedOut = () => <SignIn screen="parameters" />;
export const Empty_ = () => (
  <Shell screen="parameters">
    <Empty icon={Icon.sliders(24)} title="No parameters">
      The snapshot carries no parameter definitions. Parameters added in agents/parameters.yaml appear here with an Auto / Locked switch.
    </Empty>
  </Shell>
);
Empty_.storyName = "Empty";
