import { Link } from "@tanstack/react-router";
import { Screen } from "../../app/layout/Shell.tsx";
import type { Claim, ConsoleState, Metric } from "../../shared/api/types.ts";
import { clock, dayMonth, duration, usd } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { LineChart } from "../../shared/ui/LineChart.tsx";
import { Skel } from "../../shared/ui/parts.tsx";

function StageProgress({ stages }: { stages: Claim["stages"] }) {
  const cols = { gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` };
  const i = Math.max(
    0,
    stages.findIndex((s) => s.status === "running" || s.status === "failed"),
  );
  const at = stages[i];
  return (
    <div className="c-section" style={{ gap: 6 }}>
      <div className="c-stages" style={cols} role="img" aria-label={`Stage ${i + 1} of ${stages.length}: ${at?.name}`}>
        {stages.map((s) => (
          <div key={s.name} className={`c-seg ${s.status}`} />
        ))}
      </div>
      <div className="c-stage-labels" style={cols}>
        {stages.map((s) => (
          <span key={s.name} className={s.status}>
            {s.status === "done" ? "✓ " : s.status === "failed" ? "✕ " : ""}
            {s.name}
          </span>
        ))}
      </div>
      <div className="c-stage-caption">
        <b style={{ color: "var(--color-accent)" }}>{at?.name}</b>
        <span className="c-muted">
          {" "}
          · stage {i + 1} of {stages.length}
          {stages[i + 1] ? ` · next: ${stages[i + 1].name}` : ""}
        </span>
      </div>
    </div>
  );
}

function CurrentCard({ c, repo }: { c: Claim; repo: string }) {
  return (
    <section className="c-card c-current c-section" aria-label="Running now" style={{ gap: 16 }}>
      <div className="c-between">
        <div className="c-section" style={{ gap: 4, minWidth: 0 }}>
          <span className="c-eyebrow">
            <span style={{ color: "var(--color-accent)" }}>● Running</span> · issue #{c.issue}
          </span>
          <h2>{c.title || `Issue #${c.issue}`}</h2>
        </div>
        {c.pr ? (
          <a className="c-btn" href={`https://github.com/${repo}/pull/${c.pr}`} target="_blank" rel="noreferrer">
            PR #{c.pr} {Icon.external(16)}
          </a>
        ) : null}
      </div>
      <StageProgress stages={c.stages} />
      <dl className="c-meta">
        <div className="c-kv">
          <dt>Model</dt>
          <dd className="c-ellipsis">{c.model || "—"}</dd>
        </div>
        <div className="c-kv">
          <dt>Elapsed</dt>
          <dd>{duration(c.elapsed_s)}</dd>
        </div>
        <div className="c-kv">
          <dt>Cost so far</dt>
          <dd>{usd(c.cost_usd)}</dd>
        </div>
      </dl>
    </section>
  );
}

function IdleCard({ next }: { next: string | null }) {
  return (
    <section className="c-card c-section" aria-label="Running now" style={{ gap: 8 }}>
      <span className="c-eyebrow">Idle</span>
      <h2 style={{ fontSize: "var(--text-lg)" }}>Nothing is running</h2>
      <p className="c-muted">
        {next ? `The next tick is at ${clock(next)}. ` : ""}It claims the first ready issue in up next.
      </p>
    </section>
  );
}

function OtherClaims({ claims, repo }: { claims: Claim[]; repo: string }) {
  return (
    <ul className="c-list" aria-label="Also running">
      {claims.map((o) => (
        <li key={o.issue}>
          <a
            className="c-claim"
            href={`https://github.com/${repo}/${o.pr ? "pull" : "issues"}/${o.pr ?? o.issue}`}
            target="_blank"
            rel="noreferrer"
          >
            <span className="c-badge accent">{o.stage}</span>
            <span className="grow">
              <span className="c-ellipsis" style={{ display: "block", fontWeight: 600 }}>
                #{o.issue} {o.title}
              </span>
              <span className="c-sm c-muted">
                {duration(o.elapsed_s)} · {usd(o.cost_usd)} · {o.pr ? `PR #${o.pr}` : "no PR yet"}
              </span>
            </span>
            {Icon.chevron()}
          </a>
        </li>
      ))}
    </ul>
  );
}

function UpNext({ items }: { items: ConsoleState["up_next"] }) {
  return (
    <section className="c-card c-section" aria-label="Up next" style={{ gap: 4 }}>
      <div className="c-section-head">
        <h2>Up next</h2>
      </div>
      {items.length === 0 ? (
        <p className="c-muted" style={{ padding: "8px 0" }}>
          No issue is ready. The shortlist is empty.
        </p>
      ) : (
        <ol>
          {items.slice(0, 3).map((u, i) => (
            <li key={u.issue} className="c-next">
              <span className="c-muted c-strong" style={{ width: 16 }}>
                {i + 1}
              </span>
              <span className="grow">
                <span style={{ display: "block", fontWeight: 600 }}>#{u.issue}</span>
                <span className="c-sm">{u.title}</span>
              </span>
              <span className="c-badge">{u.class}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const TILES: { name: string; label: string; unit: string; digits: number }[] = [
  { name: "merged_per_week", label: "Merged per week", unit: "PRs", digits: 0 },
  { name: "issue_to_merge_days", label: "Median issue-to-merge", unit: "days", digits: 1 },
  { name: "rework_per_merge", label: "Rework", unit: "fix rounds", digits: 1 },
];

function MetricTile({ t, value, metric }: { t: (typeof TILES)[number]; value: number | null; metric?: Metric }) {
  const complete = metric ? metric.buckets.slice(0, -1) : [];
  const week = complete[complete.length - 1]?.bucket;
  const spark = complete.slice(-8).map((b) => b.value);
  return (
    <Link className="c-tile" to="/history" search={{ metric: t.name }}>
      <span className="label">
        {t.label}
        {Icon.chevron(16)}
      </span>
      {value === null ? (
        <>
          <span className="value none">No data</span>
          <span className="c-sm c-muted">No complete week yet</span>
        </>
      ) : (
        <>
          <span className="value">
            {value.toFixed(t.digits)}
            <small>{t.unit}</small>
          </span>
          <span className="c-sm c-muted">{week ? `week of ${dayMonth(week)}` : ""}</span>
          <LineChart
            spark
            series={[{ name: t.name, values: spark, color: "var(--color-series-1)" }]}
            weeks={[]}
            yMax={Math.max(1, ...spark.map((v) => v ?? 0))}
          />
        </>
      )}
    </Link>
  );
}

function AwsTile({ aws }: { aws: ConsoleState["tiles"]["aws"] }) {
  const capZero = aws.cap_usd === 0;
  const cap = aws.cap_usd ?? 0;
  const actual = aws.actual_usd ?? (capZero ? 0 : null);
  return (
    <Link className="c-tile" to="/parameters" search={{ focus: "aws_cap_usd" }}>
      <span className="label">
        AWS spend
        {Icon.chevron(16)}
      </span>
      {actual === null ? (
        <>
          <span className="value none">No data</span>
          <span className="c-sm c-muted">No cost pulled yet</span>
        </>
      ) : (
        <>
          <span className="value">
            {usd(actual)}
            {capZero || aws.cap_usd === null ? null : <small>of ${aws.cap_usd} cap</small>}
          </span>
          <span className="c-sm c-muted">
            {capZero
              ? "spent this month"
              : aws.forecast_usd === null
                ? ""
                : `forecast ${usd(aws.forecast_usd)} this month`}
          </span>
          {capZero ? (
            <span className="c-sm" style={{ color: "var(--color-warn)", fontWeight: 600, display: "flex", gap: 6 }}>
              {Icon.lock(16)}cap 0: nothing may be launched
            </span>
          ) : cap > 0 ? (
            <div
              className="c-meter"
              role="img"
              aria-label={`Actual ${aws.actual_usd}, forecast ${aws.forecast_usd}, cap ${cap} USD`}
            >
              <div className="fill" style={{ width: `${Math.min(100, (actual / cap) * 100)}%` }} />
              {aws.forecast_usd === null ? null : (
                <div className="mark" style={{ left: `${Math.min(100, (aws.forecast_usd / cap) * 100)}%` }} />
              )}
            </div>
          ) : null}
        </>
      )}
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div className="c-home" aria-busy="true">
      <Skel h={56} r={12} />
      <div className="c-card c-section">
        <Skel h={14} w="30%" />
        <Skel h={24} w="70%" />
        <Skel h={10} />
        <Skel h={40} />
      </div>
      <div className="c-card c-section">
        <Skel h={20} w="40%" />
        <Skel h={40} />
        <Skel h={40} />
        <Skel h={40} />
      </div>
      <div className="c-tiles full">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="c-tile">
            <Skel h={14} w="60%" />
            <Skel h={28} w="50%" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Home() {
  return (
    <Screen screen="home" skeleton={<HomeSkeleton />}>
      {(s) => {
        const open = s.questions.filter((q) => q.status !== "answered").length;
        const [first, ...rest] = s.current;
        return (
          <div className="c-home">
            {open > 0 ? (
              <Link className="c-qbanner full" to="/questions">
                <span className="c-count">{open}</span>
                <span className="grow">
                  {open} open question{open === 1 ? "" : "s"} for you
                </span>
                {Icon.chevron()}
              </Link>
            ) : null}
            <div className="c-section">
              {first ? <CurrentCard c={first} repo={s.repo} /> : <IdleCard next={s.next_tick_at} />}
              {rest.length ? <OtherClaims claims={rest} repo={s.repo} /> : null}
            </div>
            <UpNext items={s.up_next} />
            <section className="c-section full" aria-label="Stats">
              <div className="c-tiles">
                {TILES.map((t) => (
                  <MetricTile
                    key={t.name}
                    t={t}
                    value={s.tiles[t.name as "merged_per_week" | "issue_to_merge_days" | "rework_per_merge"]}
                    metric={s.metrics?.metrics.find((m) => m.name === t.name)}
                  />
                ))}
                <AwsTile aws={s.tiles.aws} />
              </div>
            </section>
          </div>
        );
      }}
    </Screen>
  );
}
