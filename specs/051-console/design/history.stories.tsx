// History (spec 051 AC-10): every metric of the report over its weekly buckets, the window selectable
// (4, 12, 26, 52 weeks); a replaced metric drawn beside its replacement; a null bucket is a gap, not a zero.
import { Empty, type Freshness, Icon, LineChart, METRICS, REPLACED, Shell, SignIn, Skel, WEEKS_12 } from "./console-kit.tsx";

export default { title: "history" };

const GOAL_TONE: Record<string, string> = { delivery: "ok", speed: "accent", quality: "violet", spend: "warn", autonomy: "" };
const WINDOWS = [4, 12, 26, 52];

function WindowControl({ weeks = 12 }: { weeks?: number }) {
  return (
    <div className="c-between" style={{ alignItems: "center", flexWrap: "wrap" }}>
      <div className="c-seg-ctl" role="group" aria-label="Window">
        {WINDOWS.map((w) => <button key={w} type="button" aria-pressed={w === weeks}>{w} wk</button>)}
      </div>
      <span className="c-sm c-muted">Weekly buckets · {WEEKS_12[0]} – week of {WEEKS_12[WEEKS_12.length - 1]}</span>
    </div>
  );
}

function CardHead({ label, goal, description, latest, direction }: { label: string; goal: string; description: string; latest: string; direction: string }) {
  return (
    <div className="c-between">
      <div className="c-section" style={{ gap: 4, minWidth: 0 }}>
        <div className="c-wrap"><h2 style={{ fontSize: "var(--text-lg)", fontWeight: 650 }}>{label}</h2><span className={`c-badge ${GOAL_TONE[goal]}`}>{goal}</span></div>
        <p className="c-sm c-muted">{description}</p>
      </div>
      <div style={{ textAlign: "right", flex: "none" }}>
        <div style={{ fontSize: "var(--text-lg)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{latest}</div>
        <div className="c-sm c-muted">{direction} is better</div>
      </div>
    </div>
  );
}

function CardFoot({ name, gaps }: { name: string; gaps?: boolean }) {
  return (
    <div className="c-between" style={{ alignItems: "center" }}>
      <span className="c-sm c-muted">{gaps ? "Gap: no events in the week of 1 Sep" : <span className="c-mono">{name}</span>}</span>
      <button type="button" className="c-btn">Table</button>
    </div>
  );
}

function MetricCard({ m, hover, focus }: { m: (typeof METRICS)[number]; hover?: boolean; focus?: boolean }) {
  const last = m.values[m.values.length - 1];
  const ticks = m.name === "rework_per_merge" ? [0, 0.5, 1, 1.5] : [0, m.yMax / 2, m.yMax];
  return (
    <section className={`c-card c-section${focus ? " c-focus" : ""}`} id={`history-${m.name}`} style={{ gap: 12 }}>
      <CardHead label={m.label} goal={m.goal} description={m.description} latest={`${last === null ? "–" : m.fmt(last)} ${m.unit === "fix rounds per merge" ? "rounds" : m.unit}`} direction={m.direction} />
      <LineChart
        series={[{ name: m.name, values: [...m.values], color: "var(--color-series-1)" }]}
        weeks={WEEKS_12}
        yMax={m.yMax}
        yTicks={ticks}
        fmt={(n) => (m.name === "merged_per_week" ? String(n) : n.toFixed(1))}
        hover={hover ? { index: 9, lines: [`Week of ${WEEKS_12[9]}`, `${m.fmt(m.values[9] as number)} ${m.unit}`] } : undefined}
      />
      <CardFoot name={m.name} gaps />
    </section>
  );
}

function ReplacedCard() {
  const r = REPLACED;
  return (
    <section className="c-card c-section" id={`history-${r.name}`} style={{ gap: 12 }}>
      <CardHead label={r.label} goal={r.goal} description={r.description} latest={`$${r.values[r.values.length - 1]?.toFixed(2)}`} direction={r.direction} />
      <div className="c-legend" aria-label="Legend">
        <span className="c-key"><i style={{ borderColor: "var(--color-series-1)" }} /><span className="c-mono">{r.name}</span> (new)</span>
        <span className="c-key"><i className="dash" style={{ borderColor: "var(--color-series-2)" }} /><span className="c-mono">{r.replaces}</span> (replaced)</span>
      </div>
      <LineChart
        series={[
          { name: r.replaces, values: r.old, color: "var(--color-series-2)", dashed: true },
          { name: r.name, values: r.values, color: "var(--color-series-1)" },
        ]}
        weeks={WEEKS_12}
        yMax={r.yMax}
        fmt={(n) => `$${n}`}
      />
      <div className="c-note locked"><span style={{ flex: "none" }}>{Icon.chart(18)}</span><span>Replaced on 13 Oct. Both are drawn for 23 more days of overlap, then only the new metric.</span></div>
      <CardFoot name={r.name} />
    </section>
  );
}

function History({ fresh = "fresh", focus }: { fresh?: Freshness; focus?: string }) {
  return (
    <Shell screen="history" fresh={fresh}>
      <WindowControl />
      <div className="c-charts">
        {METRICS.map((m, i) => <MetricCard key={m.name} m={m} hover={i === 0 && !focus} focus={focus === m.name} />)}
        <ReplacedCard />
      </div>
    </Shell>
  );
}

export const Default = () => <History />;
/** Opened from Home's issue-to-merge tile: that card is scrolled into view and outlined for 2 s. */
export const FromTile = () => <History focus="issue_to_merge_days" />;
export const Loading = () => (
  <Shell screen="history" fresh="loading" openQuestions={0}>
    <Skel h={50} w={300} />
    <div className="c-charts" aria-busy="true">
      {[0, 1].map((k) => <div key={k} className="c-card c-section"><Skel h={22} w="40%" /><Skel h={14} w="70%" /><Skel h={168} /></div>)}
    </div>
  </Shell>
);
export const Stale = () => <History fresh="stale" />;
export const Unreachable = () => <History fresh="offline" />;
export const SignedOut = () => <SignIn screen="history" />;
export const Empty_ = () => (
  <Shell screen="history">
    <Empty icon={Icon.chart(24)} title="No metrics report yet">
      The scheduler has not sent a metrics report. Charts appear once the first full week of recorded events has been computed.
    </Empty>
  </Shell>
);
Empty_.storyName = "Empty";
