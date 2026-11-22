export interface Series {
  name: string;
  values: (number | null)[];
  color: string;
  dashed?: boolean;
}

function segments(values: (number | null)[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([i, v]);
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Line chart: lines in a stretched SVG with non-scaling strokes, labels and points in HTML so text never scales. A null is a gap. */
export function LineChart({
  series,
  weeks,
  yMax,
  yTicks,
  fmt = (n: number) => String(n),
  spark,
  hover,
}: {
  series: Series[];
  weeks: string[];
  yMax: number;
  yTicks?: number[];
  fmt?: (n: number) => string;
  spark?: boolean;
  hover?: { index: number; lines: string[] };
}) {
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / yMax) * 100;
  const ticks = yTicks ?? [0, yMax / 2, yMax];
  const labelIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1];
  return (
    <div>
      <div className={`c-chart${spark ? " spark" : ""}`}>
        {!spark &&
          ticks.map((t) => (
            <div key={t}>
              <div className="c-grid" style={{ top: `${y(t)}%` }} />
              <div className="c-ylab" style={{ top: `${y(t)}%` }}>
                {fmt(t)}
              </div>
            </div>
          ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {series.map((s) =>
            segments(s.values)
              .filter((seg) => seg.length > 1)
              .map((seg) => (
                <polyline
                  key={`${s.name}-${seg[0][0]}`}
                  points={seg.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? "6 4" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )),
          )}
        </svg>
        {series.map((s) =>
          segments(s.values).map((seg) => {
            // A lone point between gaps has no line, so it gets a marker; the last point of each series is marked too.
            const marks =
              seg.length === 1 ? seg : seg[seg.length - 1][0] === s.values.length - 1 ? [seg[seg.length - 1]] : [];
            return marks.map(([i, v]) => (
              <span
                key={`${s.name}-p${i}`}
                className="c-pt"
                style={{ left: `${x(i)}%`, top: `${y(v)}%`, background: s.color }}
              />
            ));
          }),
        )}
        {hover ? (
          <>
            <div className="c-cross" style={{ left: `${x(hover.index)}%` }} />
            {series.map((s) => {
              const v = s.values[hover.index];
              return v === null || v === undefined ? null : (
                <span
                  key={`h-${s.name}`}
                  className="c-pt c-pt-hover"
                  style={{ left: `${x(hover.index)}%`, top: `${y(v)}%`, background: s.color }}
                />
              );
            })}
            <div className={`c-tip${hover.index < n / 4 ? " flip" : ""}`} style={{ left: `${x(hover.index)}%` }}>
              {hover.lines.map((l, i) => (
                <div key={l} style={{ fontWeight: i === 0 ? 600 : 400 }}>
                  {l}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {!spark ? (
        <div className="c-xlabs">
          {labelIdx.map((i, k) => (
            <span
              key={i}
              className={`c-xlab${k === 0 ? " first" : k === labelIdx.length - 1 ? " last" : ""}`}
              style={{ left: `${x(i)}%` }}
            >
              {weeks[i]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
