// Home, direction A (design section 9; spec 051 AC-8): questions banner, one large card for the oldest
// running claim with further claims as compact rows, up next, four stat tiles.
import {
  CURRENT, type Freshness, Icon, LineChart, METRICS, OTHER_CLAIMS, Shell, SignIn, SignInRefused, Skel, UP_NEXT,
} from "./console-kit.tsx";

export default { title: "home" };

type Current = typeof CURRENT;

function StageProgress({ stages }: { stages: Current["stages"] }) {
  const cols = { gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` };
  const i = stages.findIndex((s) => s.status === "running" || s.status === "failed");
  const at = stages[i];
  return (
    <div className="c-section" style={{ gap: 6 }}>
      <div className="c-stages" style={cols} role="img" aria-label={`Stage ${i + 1} of ${stages.length}: ${at?.name}`}>
        {stages.map((s) => <div key={s.name} className={`c-seg ${s.status}`} />)}
      </div>
      <div className="c-stage-labels" style={cols}>
        {stages.map((s) => (
          <span key={s.name} className={s.status}>{s.status === "done" ? "✓ " : s.status === "failed" ? "✕ " : ""}{s.name}</span>
        ))}
      </div>
      <div className="c-stage-caption">
        <b style={{ color: "var(--color-accent)" }}>{at?.name}</b>
        <span className="c-muted"> · stage {i + 1} of {stages.length}{stages[i + 1] ? ` · next: ${stages[i + 1].name}` : ""}</span>
      </div>
    </div>
  );
}

function CurrentCard({ c }: { c: Current }) {
  return (
    <section className="c-card c-current c-section" aria-label="Running now" style={{ gap: 16 }}>
      <div className="c-between">
        <div className="c-section" style={{ gap: 4, minWidth: 0 }}>
          <span className="c-eyebrow"><span style={{ color: "var(--color-accent)" }}>● Running</span> · issue #{c.issue}</span>
          <h2>{c.title}</h2>
        </div>
        <a className="c-btn" href={`#pr-${c.pr}`}>PR #{c.pr} {Icon.external(16)}</a>
      </div>
      <StageProgress stages={c.stages} />
      <dl className="c-meta">
        <div className="c-kv"><dt>Model</dt><dd className="c-ellipsis">{c.model}</dd></div>
        <div className="c-kv"><dt>Elapsed</dt><dd>{c.elapsed}</dd></div>
        <div className="c-kv"><dt>Cost so far</dt><dd>{c.cost}</dd></div>
      </dl>
    </section>
  );
}

function IdleCard() {
  return (
    <section className="c-card c-section" aria-label="Running now" style={{ gap: 8 }}>
      <span className="c-eyebrow">Idle</span>
      <h2 style={{ fontSize: "var(--text-lg)" }}>Nothing is running</h2>
      <p className="c-muted">The next tick is at 10:46 (in 2 min). It claims the first ready issue in up next.</p>
    </section>
  );
}

function OtherClaims() {
  return (
    <ul className="c-list" aria-label="Also running">
      {OTHER_CLAIMS.map((o) => (
        <li key={o.issue}>
          <a className="c-claim" href={o.pr ? `#pr-${o.pr}` : `#issue-${o.issue}`}>
            <span className="c-badge accent">{o.stage}</span>
            <span className="grow">
              <span className="c-ellipsis" style={{ display: "block", fontWeight: 600 }}>#{o.issue} {o.title}</span>
              <span className="c-sm c-muted">{o.elapsed} · {o.cost} · {o.pr ? `PR #${o.pr}` : "no PR yet"}</span>
            </span>
            {Icon.chevron()}
          </a>
        </li>
      ))}
    </ul>
  );
}

function UpNext({ empty }: { empty?: boolean }) {
  return (
    <section className="c-card c-section" aria-label="Up next" style={{ gap: 4 }}>
      <div className="c-section-head"><h2>Up next</h2></div>
      {empty ? (
        <p className="c-muted" style={{ padding: "8px 0" }}>No issue is ready. The shortlist is empty.</p>
      ) : (
        <ol>
          {UP_NEXT.slice(0, 3).map((u, i) => (
            <li key={u.issue} className="c-next">
              <span className="c-muted c-strong" style={{ width: 16 }}>{i + 1}</span>
              <span className="grow">
                <span style={{ display: "block", fontWeight: 600 }}>#{u.issue}</span>
                <span className="c-sm">{u.title}</span>
              </span>
              <span className="c-badge">{u.cls}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MetricTile({ m, empty }: { m: (typeof METRICS)[number]; empty?: boolean }) {
  const last = m.values[m.values.length - 1];
  const unit = m.name === "merged_per_week" ? "PRs" : m.name === "issue_to_merge_days" ? "days" : "fix rounds";
  return (
    <a className="c-tile" href={`#history-${m.name}`}>
      <span className="label">{m.label}{Icon.chevron(16)}</span>
      {empty || last === null ? (
        <>
          <span className="value none">No data</span>
          <span className="c-sm c-muted">No complete week yet</span>
        </>
      ) : (
        <>
          <span className="value">{m.fmt(last)}<small>{unit}</small></span>
          <span className="c-sm c-muted">week of 3 Nov</span>
          <LineChart spark series={[{ name: m.name, values: m.values.slice(-8), color: "var(--color-series-1)" }]} weeks={[]} yMax={m.yMax} />
        </>
      )}
    </a>
  );
}

function AwsTile({ capZero }: { capZero?: boolean }) {
  return (
    <a className="c-tile" href="#parameters-aws_cap_usd">
      <span className="label">AWS spend{Icon.chevron(16)}</span>
      {capZero ? (
        <>
          <span className="value">$0.00</span>
          <span className="c-sm c-muted">spent this month</span>
          <span className="c-sm" style={{ color: "var(--color-warn)", fontWeight: 600, display: "flex", gap: 6 }}>{Icon.lock(16)}cap 0: nothing may be launched</span>
        </>
      ) : (
        <>
          <span className="value">$0.84<small>of $5 cap</small></span>
          <span className="c-sm c-muted">forecast $1.90 this month</span>
          <div className="c-meter" role="img" aria-label="Actual 0.84, forecast 1.90, cap 5 USD">
            <div className="fill" style={{ width: "16.8%" }} />
            <div className="mark" style={{ left: "38%" }} />
          </div>
        </>
      )}
    </a>
  );
}

function QuestionsBanner({ n }: { n: number }) {
  return (
    <a className="c-qbanner full" href="#questions">
      <span className="c-count">{n}</span>
      <span className="grow">{n} open question{n === 1 ? "" : "s"} for you</span>
      {Icon.chevron()}
    </a>
  );
}

function Home({ fresh = "fresh", idle, empty }: { fresh?: Freshness; idle?: boolean; empty?: boolean }) {
  const questions = empty ? 0 : 2;
  return (
    <Shell screen="home" fresh={fresh} openQuestions={questions}>
      <div className="c-home">
        {questions > 0 ? <QuestionsBanner n={questions} /> : null}
        <div className="c-section">
          {idle || empty ? <IdleCard /> : <CurrentCard c={CURRENT} />}
          {idle || empty ? null : <OtherClaims />}
        </div>
        <UpNext empty={empty} />
        <section className="c-section full" aria-label="Stats">
          <div className="c-tiles">
            {METRICS.map((m) => <MetricTile key={m.name} m={m} empty={empty} />)}
            <AwsTile capZero={empty} />
          </div>
        </section>
      </div>
    </Shell>
  );
}

export const Default = () => <Home />;

export const Loading = () => (
  <Shell screen="home" fresh="loading" openQuestions={0}>
    <div className="c-home" aria-busy="true">
      <Skel h={56} r={12} />
      <div className="c-card c-section"><Skel h={14} w="30%" /><Skel h={24} w="70%" /><Skel h={10} /><Skel h={40} /></div>
      <div className="c-card c-section"><Skel h={20} w="40%" /><Skel h={40} /><Skel h={40} /><Skel h={40} /></div>
      <div className="c-tiles full">{[0, 1, 2, 3].map((k) => <div key={k} className="c-tile"><Skel h={14} w="60%" /><Skel h={28} w="50%" /></div>)}</div>
    </div>
  </Shell>
);

export const Stale = () => <Home fresh="stale" />;
export const Unreachable = () => <Home fresh="offline" />;
export const SignedOut = () => <SignIn screen="home" />;
export const SignInRefusedLogin = () => <SignInRefused />;
/** Idle system, no open questions, no metrics report yet, and the AWS cap at 0. */
export const Empty = () => <Home empty />;
/** Idle system with data: no claim running, the next tick time shown. */
export const Idle = () => <Home idle />;
