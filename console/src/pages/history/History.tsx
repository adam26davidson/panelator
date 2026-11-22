import { useNavigate, useSearch } from "@tanstack/react-router";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Screen } from "../../app/layout/Shell.tsx";
import type { Metric } from "../../shared/api/types.ts";
import { dayMonth } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { LineChart } from "../../shared/ui/LineChart.tsx";
import { Empty, Skel } from "../../shared/ui/parts.tsx";

const GOAL_TONE: Record<string, string> = { delivery: "ok", speed: "accent", quality: "violet", spend: "warn" };
const WINDOWS = [4, 12, 26, 52];

const niceMax = (v: number): number => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const fmtValue = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The complete weekly buckets only: the report's last bucket is the week still running. */
const complete = (m: Metric, weeks: number) => m.buckets.slice(0, -1).slice(-weeks);

function MetricCard({ m, old, weeks, focus }: { m: Metric; old?: Metric; weeks: number; focus: boolean }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const buckets = complete(m, weeks);
  const oldBuckets = old ? complete(old, weeks) : null;
  const values = buckets.map((b) => b.value);
  const all = [...values, ...(oldBuckets?.map((b) => b.value) ?? [])].filter((v): v is number => v !== null);
  const yMax = niceMax(Math.max(0, ...all));
  const labels = buckets.map((b) => dayMonth(b.bucket));
  const latest = [...values].reverse().find((v) => v !== null) ?? null;
  const gaps = buckets.filter((b) => b.value === null).map((b) => dayMonth(b.bucket));

  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const plot = e.currentTarget.querySelector(".c-chart")?.getBoundingClientRect();
    if (!plot || plot.width === 0 || buckets.length < 2) return;
    const i = Math.round(((e.clientX - plot.left) / plot.width) * (buckets.length - 1));
    setHover(Math.min(buckets.length - 1, Math.max(0, i)));
  };
  const hv =
    hover === null
      ? undefined
      : {
          index: hover,
          lines: [
            `Week of ${labels[hover]}`,
            ...[m, ...(old ? [old] : [])].map((x, k) => {
              const v = (k === 0 ? buckets : (oldBuckets ?? []))[hover]?.value ?? null;
              return `${old ? `${x.name}: ` : ""}${v === null ? "no data" : `${fmtValue(v)} ${x.unit}`}`;
            }),
          ],
        };

  return (
    <section
      ref={ref}
      className={`c-card c-section${focus ? " c-focus" : ""}`}
      id={`history-${m.name}`}
      style={{ gap: 12 }}
    >
      <div className="c-between">
        <div className="c-section" style={{ gap: 4, minWidth: 0 }}>
          <div className="c-wrap">
            <h2 style={{ fontSize: "var(--text-lg)", fontWeight: 650 }}>{m.name.replaceAll("_", " ")}</h2>
            <span className={`c-badge ${GOAL_TONE[m.goal] ?? ""}`}>{m.goal}</span>
          </div>
          <p className="c-sm c-muted">{m.description}</p>
        </div>
        <div style={{ textAlign: "right", flex: "none" }}>
          <div style={{ fontSize: "var(--text-lg)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {latest === null ? "–" : fmtValue(latest)} {m.unit}
          </div>
          <div className="c-sm c-muted">{m.direction} is better</div>
        </div>
      </div>
      {old ? (
        <div className="c-legend" role="group" aria-label="Legend">
          <span className="c-key">
            <i style={{ borderColor: "var(--color-series-1)" }} />
            <span className="c-mono">{m.name}</span> (new)
          </span>
          <span className="c-key">
            <i className="dash" style={{ borderColor: "var(--color-series-2)" }} />
            <span className="c-mono">{old.name}</span> (replaced)
          </span>
        </div>
      ) : null}
      {table ? (
        <table className="c-sm" aria-label={`${m.name} by week`}>
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col">Value</th>
              <th scope="col">n</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.bucket}>
                <td>{dayMonth(b.bucket)}</td>
                <td>{b.value === null ? "no data" : fmtValue(b.value)}</td>
                <td>{b.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`${m.name}, weekly, last ${buckets.length} weeks`}
        >
          <LineChart
            series={[
              ...(oldBuckets
                ? [
                    {
                      name: old?.name ?? "",
                      values: oldBuckets.map((b) => b.value),
                      color: "var(--color-series-2)",
                      dashed: true,
                    },
                  ]
                : []),
              { name: m.name, values, color: "var(--color-series-1)" },
            ]}
            weeks={labels}
            yMax={yMax}
            fmt={fmtValue}
            hover={hv}
          />
        </div>
      )}
      {old ? (
        <div className="c-note locked">
          <span style={{ flex: "none" }}>{Icon.chart(18)}</span>
          <span>
            Replaced on {dayMonth(m.introduced)}. Both are drawn for {old.overlap_days_left ?? 0} more days of overlap,
            then only the new metric.
          </span>
        </div>
      ) : null}
      <div className="c-between" style={{ alignItems: "center" }}>
        <span className="c-sm c-muted">
          {gaps.length ? (
            `Gap: no events in the week of ${gaps.slice(0, 3).join(", ")}`
          ) : (
            <span className="c-mono">{m.name}</span>
          )}
        </span>
        <button type="button" className="c-btn" aria-pressed={table} onClick={() => setTable(!table)}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
    </section>
  );
}

export function History() {
  const search = useSearch({ strict: false }) as { weeks?: number; metric?: string };
  const navigate = useNavigate();
  const weeks = WINDOWS.includes(Number(search.weeks)) ? Number(search.weeks) : 12;
  const [focus, setFocus] = useState<string | null>(search.metric ?? null);
  useEffect(() => {
    if (!search.metric) return;
    setFocus(search.metric);
    const t = setTimeout(() => setFocus(null), 2000);
    return () => clearTimeout(t);
  }, [search.metric]);
  return (
    <Screen
      screen="history"
      skeleton={
        <>
          <Skel h={50} w={300} />
          <div className="c-charts" aria-busy="true">
            {[0, 1].map((k) => (
              <div key={k} className="c-card c-section">
                <Skel h={22} w="40%" />
                <Skel h={14} w="70%" />
                <Skel h={168} />
              </div>
            ))}
          </div>
        </>
      }
    >
      {(s) => {
        const metrics = s.metrics?.metrics ?? [];
        if (!metrics.length) {
          return (
            <Empty icon={Icon.chart(24)} title="No metrics report yet">
              The scheduler has not sent a metrics report. Charts appear once the first full week of recorded events has
              been computed.
            </Empty>
          );
        }
        const byName = new Map(metrics.map((m) => [m.name, m]));
        // A replaced metric is drawn in its replacement's card for as long as the report carries both.
        const drawn = metrics.filter((m) => !(m.replaced_by && byName.has(m.replaced_by)));
        const olds = new Map(
          metrics.filter((m) => m.replaced_by && byName.has(m.replaced_by)).map((m) => [m.replaced_by as string, m]),
        );
        const first = metrics[0]?.buckets[0]?.bucket;
        const last = metrics[0]?.buckets.at(-2)?.bucket;
        return (
          <>
            <div className="c-between" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <div className="c-seg-ctl" role="group" aria-label="Window">
                {WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={w === weeks}
                    onClick={() =>
                      void navigate({ to: ".", search: (prev: object) => ({ ...prev, weeks: w }) } as never)
                    }
                  >
                    {w} wk
                  </button>
                ))}
              </div>
              {first && last ? (
                <span className="c-sm c-muted">
                  Weekly buckets · {dayMonth(first)} – week of {dayMonth(last)}
                </span>
              ) : null}
            </div>
            <div className="c-charts">
              {drawn.map((m) => (
                <MetricCard key={m.name} m={m} old={olds.get(m.name)} weeks={weeks} focus={focus === m.name} />
              ))}
            </div>
          </>
        );
      }}
    </Screen>
  );
}
