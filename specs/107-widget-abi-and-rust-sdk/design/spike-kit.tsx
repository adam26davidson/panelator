// Shared page markup and tokens for the spike-widget design stories (spec 107 section 6).
// Not a story file: every <screen>.stories.tsx composes these pieces, so the four screens use one
// token set (recorded in tokens.html) and one page layout. The pixels come from spike-pixels.ts.
import type { ReactNode } from "react";
import { type Frame, hex } from "./spike-pixels.ts";

/* ------------------------------------------------------------------ tokens and styles */

const CSS = `
.s-root {
  --color-border: #d5d9e0;
  --color-stage: #000000;
  --color-stage-text: #e6e9ee;
  --color-stage-edge: #5b6573;
  --px-w: 320px;
  min-height: 100vh; box-sizing: border-box; padding: var(--space-4);
  background: var(--color-surface); color: var(--color-text);
  font-family: var(--font-sans); font-size: var(--text-base); line-height: 1.45;
}
.s-root *, .s-root *::before, .s-root *::after { box-sizing: border-box; }
.s-root h1, .s-root h2, .s-root p, .s-root figure { margin: 0; }
.s-inner { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6); }
.s-head { display: flex; flex-direction: column; gap: var(--space-2); }
.s-eyebrow { font-size: var(--text-sm); color: var(--color-muted); }
.s-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.s-title h1 { font-size: var(--text-xl); line-height: 1.2; font-family: var(--font-mono); }
.s-chip { font-size: var(--text-sm); font-family: var(--font-mono); padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-lg); border: 1px solid var(--color-border); background: var(--color-bg); }
.s-root h2 { font-size: var(--text-lg); line-height: 1.3; }
.s-section { display: flex; flex-direction: column; gap: var(--space-3); }
.s-muted { color: var(--color-muted); }
.s-sm { font-size: var(--text-sm); }
.s-mono { font-family: var(--font-mono); font-size: var(--text-sm); overflow-wrap: anywhere; }

/* the stage: the layer as raw pixels on black, one square per LED */
.s-stage { background: var(--color-stage); color: var(--color-stage-text); border-radius: var(--radius-md);
  padding: var(--space-4) 0 var(--space-6); display: flex; flex-direction: column; align-items: center; gap: var(--space-6); }
.s-fig { display: flex; flex-direction: column; gap: var(--space-3); width: var(--px-w); }
.s-fig figcaption { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); }
.s-fig-title { font-family: var(--font-mono); font-size: var(--text-base); font-weight: 600; color: #ffffff; }
.s-px { display: block; width: var(--px-w); height: auto; image-rendering: pixelated;
  outline: 1px solid var(--color-stage-edge); }

/* tables: stacked on mobile, three columns from tablet up */
.s-table { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
.s-tr { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border); }
.s-tr:first-child, .s-th + .s-tr { border-top: 0; }
.s-th { display: none; }
.s-cell { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.s-k { font-size: var(--text-sm); color: var(--color-muted); }
.s-name { font-weight: 600; }
.s-color { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.s-swatch { width: 24px; height: 24px; flex: none; border-radius: var(--radius-sm); border: 1px solid var(--color-border);
  background: var(--color-stage); overflow: hidden; }
.s-swatch > span { display: block; width: 100%; height: 100%; }

@media (min-width: 720px) {
  .s-root { --px-w: 768px; }
  .s-tr { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.35fr) minmax(0, 1fr); gap: var(--space-6); }
  .s-th { display: grid; background: var(--color-surface); font-weight: 600; font-size: var(--text-sm); }
  .s-th + .s-tr { border-top: 1px solid var(--color-border); }
  .s-k { display: none; }
}
@media (min-width: 1200px) {
  .s-root { --px-w: 1024px; padding: var(--space-8); }
}
`;

/* ------------------------------------------------------------------ pixels */

/** The frame as a 24-bit BMP data URL: shown with `image-rendering: pixelated`, every LED is one flat square. */
function bmpUrl(f: Frame): string {
  const stride = (f.w * 3 + 3) & ~3;
  const size = 54 + stride * f.h;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 0x42;
  b[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, f.w, true);
  v.setInt32(22, f.h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, stride * f.h, true);
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      const s = (y * f.w + x) * 3;
      const d = 54 + (f.h - 1 - y) * stride + x * 3;
      b[d] = f.rgb[s + 2];
      b[d + 1] = f.rgb[s + 1];
      b[d + 2] = f.rgb[s];
    }
  let bin = "";
  for (const byte of b) bin += String.fromCharCode(byte);
  return `data:image/bmp;base64,${btoa(bin)}`;
}

/** One state of a screen: its name, what the frame holds, and the frame itself. */
export function Shot({ title, meta, frame, alt }: { title: string; meta: ReactNode; frame: Frame; alt: string }) {
  return (
    <figure className="s-fig">
      <figcaption>
        <span className="s-fig-title">{title}</span>
        <span>{meta}</span>
      </figcaption>
      <img className="s-px" src={bmpUrl(frame)} width={frame.w} height={frame.h} alt={alt} />
    </figure>
  );
}

/* ------------------------------------------------------------------ page */

export function Sheet(p: { screen: string; state?: string; lead: ReactNode; shots: ReactNode; children: ReactNode }) {
  return (
    <div className="s-root">
      <style>{CSS}</style>
      <main className="s-inner">
        <header className="s-head">
          <p className="s-eyebrow">Spec 107 · spike widgets · raw layer pixels, one square per LED</p>
          <div className="s-title">
            <h1>{p.screen}</h1>
            {p.state ? <span className="s-chip">state: {p.state}</span> : null}
          </div>
          <p>{p.lead}</p>
        </header>
        <section className="s-stage" aria-label="Frames">
          {p.shots}
          <p className="s-sm" style={{ width: "var(--px-w)" }}>
            The grey outline marks the frame's edge; it is not part of the frame.
          </p>
        </section>
        {p.children}
      </main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="s-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export type Row = [ReactNode, ReactNode, ReactNode];

/** Three columns from tablet up; on mobile each row stacks and every value carries its column's name. */
export function Table({ head, rows }: { head: [string, string, string]; rows: Row[] }) {
  return (
    <div className="s-table" role="table">
      <div className="s-tr s-th" role="row">
        {head.map((h) => (
          <span key={h} role="columnheader">{h}</span>
        ))}
      </div>
      {rows.map((cells, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static rows
        <div className="s-tr" role="row" key={i}>
          {cells.map((c, j) => (
            <div className="s-cell" role="cell" key={head[j]}>
              {j > 0 ? <span className="s-k">{head[j]}</span> : null}
              {c}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The first cell of a row: the element's name and how it is drawn. */
export function Name({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <>
      <span className="s-name">{name}</span>
      {children ? <span className="s-sm s-muted">{children}</span> : null}
    </>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="s-mono">{children}</span>;
}

export function Note({ children }: { children: ReactNode }) {
  return <span className="s-sm s-muted">{children}</span>;
}

/** A colour as the ABI writes it, 0xRRGGBBAA, with a swatch of it on black. */
export function Color({ color, name }: { color: number; name: string }) {
  const c = color >>> 0;
  const css = `rgb(${c >>> 24} ${(c >>> 16) & 255} ${(c >>> 8) & 255} / ${(c & 255) / 255})`;
  return (
    <span className="s-color">
      <span className="s-swatch" aria-hidden="true">
        <span style={{ background: css }} />
      </span>
      <span className="s-mono">{hex(c)}</span>
      <span className="s-sm s-muted">{name}</span>
    </span>
  );
}
