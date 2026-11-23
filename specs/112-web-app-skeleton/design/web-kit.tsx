// Shared markup and tokens for the product web app's design stories (spec 112).
// Not a story file: every <screen>.stories.tsx composes these pieces, so the three screens use one
// token set (recorded in tokens.html) and one frame. `@panelator/web` does not exist on main yet, so
// this file carries its own markup; flow.md maps each piece to the component the app builds.
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ tokens and styles */

// The product's token set: the base names of tools/design-stage/src/tokens.css with the product's
// own colour values (one dark theme) and breakpoints, plus the extensions marked below. The media
// queries repeat --bp-tablet (720px) and --bp-desktop (1200px) as numbers because CSS cannot read a
// custom property inside a media query.
const CSS = `
.p-root {
  /* colour: base names, product values */
  --color-bg: #0e1116;
  --color-surface: #161b22;
  --color-text: #e9edf2;
  --color-muted: #a7b1be;
  --color-accent: #6cb6ff;
  --color-danger: #ff9189;
  --color-ok: #5fd39a;
  /* colour: extensions */
  --color-raised: #1f2630;
  --color-border: #2b3340;
  --color-border-strong: #7d8896;
  --color-accent-hover: #92c9ff;
  --color-accent-soft: #152a41;
  --color-on-accent: #0b1320;
  --color-focus: #ffffff;

  /* type: base scale unchanged, one step added */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --text-sm: 14px;
  --text-base: 16px;
  --text-lg: 20px;
  --text-xl: 28px;
  --text-2xl: 36px;
  --leading-tight: 1.2;
  --leading-normal: 1.55;
  --font-weight-normal: 400;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  --tracking-wide: 0.06em;

  /* spacing: base steps unchanged, two added */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;

  /* sizes */
  --size-tap: 44px;
  --size-band: 56px;
  --size-band-wide: 64px;
  --size-tabbar: 56px;
  --size-reading: 680px;
  --size-term: 144px;

  /* radii: base unchanged */
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-lg: 20px;

  /* lines */
  --line: 1px;
  --line-focus: 2px;

  /* breakpoints: base names, product values */
  --bp-tablet: 720px;
  --bp-desktop: 1200px;

  --pad-x: var(--space-4);
  min-height: 100vh; display: flex; flex-direction: column;
  background: var(--color-bg); color: var(--color-text);
  font-family: var(--font-sans); font-size: var(--text-base); line-height: var(--leading-normal);
  font-weight: var(--font-weight-normal);
  color-scheme: dark;
}
.p-root *, .p-root *::before, .p-root *::after { box-sizing: border-box; }
.p-root h1, .p-root p, .p-root dl, .p-root dt, .p-root dd { margin: 0; }
.p-root :focus-visible { outline: var(--line-focus) solid var(--color-focus); outline-offset: var(--line-focus); }
.p-root h1:focus { outline: none; }

/* frame: Frame */
.p-band { flex: none; display: flex; align-items: center; gap: var(--space-6); height: var(--size-band);
  padding: 0 var(--pad-x); background: var(--color-surface); border-bottom: var(--line) solid var(--color-border); }
.p-brand { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--size-tap);
  margin-left: calc(-1 * var(--space-1)); padding: 0 var(--space-1); border-radius: var(--radius-sm);
  color: var(--color-text); text-decoration: none; font-size: var(--text-lg); font-weight: var(--font-weight-bold);
  line-height: var(--leading-tight); }
.p-brand svg { height: var(--space-6); width: auto; flex: none; }
.p-brand .lit { fill: var(--color-accent); }
.p-brand .unlit { fill: var(--color-border); }
.p-brand:hover .lit { fill: var(--color-accent-hover); }
.p-main { flex: 1; min-width: 0; display: block; }

/* main region at reading width: ReadingColumn */
.p-reading { width: 100%; max-width: calc(var(--size-reading) + 2 * var(--pad-x)); margin: 0 auto;
  padding: var(--space-8) var(--pad-x) var(--space-12); display: flex; flex-direction: column; gap: var(--space-8); }

/* PageHeading */
.p-heading { display: flex; flex-direction: column; gap: var(--space-3); }
.p-eyebrow { font-size: var(--text-sm); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-wide);
  text-transform: uppercase; color: var(--color-muted); }
.p-eyebrow.danger { color: var(--color-danger); }
.p-heading h1 { font-size: var(--text-xl); line-height: var(--leading-tight); font-weight: var(--font-weight-bold);
  text-wrap: balance; }
.p-root .p-lead { margin-top: var(--space-1); font-size: var(--text-base); color: var(--color-text); }

/* Button and ButtonLink */
.p-actions { display: flex; flex-direction: column; gap: var(--space-3); }
.p-btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--size-tap);
  padding: 0 var(--space-6); border-radius: var(--radius-sm); border: var(--line) solid transparent;
  font: inherit; font-weight: var(--font-weight-semibold); line-height: var(--leading-tight); text-decoration: none;
  cursor: pointer; }
.p-btn.primary { background: var(--color-accent); color: var(--color-on-accent); }
.p-btn.primary:hover { background: var(--color-accent-hover); }
.p-btn.secondary { background: transparent; color: var(--color-text); border-color: var(--color-border-strong); }
.p-btn.secondary:hover { background: var(--color-raised); }

/* home page */
.p-parts { display: flex; flex-direction: column; border-top: var(--line) solid var(--color-border); }
.p-part { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4) 0;
  border-bottom: var(--line) solid var(--color-border); }
.p-part dt { font-weight: var(--font-weight-semibold); }
.p-part dd { color: var(--color-muted); }
.p-status { padding: var(--space-4); border-radius: var(--radius-md); background: var(--color-surface);
  border: var(--line) solid var(--color-border); color: var(--color-muted); }
.p-status strong { color: var(--color-text); font-weight: var(--font-weight-semibold); }

@media (min-width: 720px) {
  .p-root { --pad-x: var(--space-6); }
  .p-band { height: var(--size-band-wide); }
  .p-reading { padding-top: var(--space-12); padding-bottom: var(--space-16); }
  .p-heading h1 { font-size: var(--text-2xl); }
  .p-lead { font-size: var(--text-lg); }
  .p-actions { flex-direction: row; }
  .p-part { flex-direction: row; gap: var(--space-6); }
  .p-part dt { flex: none; width: var(--size-term); }
}
@media (min-width: 1200px) {
  .p-root { --pad-x: var(--space-8); }
  .p-reading { padding-top: var(--space-16); }
}
`;

/* ------------------------------------------------------------------ the frame */

// The brand mark: a dot-matrix "p", five rows of three dots. It is a logo, not a panel: it has no
// relation to any board's geometry.
const MARK_ROWS = ["##.", "#.#", "##.", "#..", "#.."];

function Mark() {
  return (
    <svg viewBox="0 0 12 20" aria-hidden="true" focusable="false">
      {MARK_ROWS.flatMap((row, y) =>
        [...row].map((c, x) => (
          <circle key={`${x}-${y}`} className={c === "#" ? "lit" : "unlit"} cx={2 + x * 4} cy={2 + y * 4} r={1.5} />
        )),
      )}
    </svg>
  );
}

/**
 * The frame every screen is shown inside (AC-6): a banner with the product's name as the link home,
 * and the main region. flow.md says where primary navigation and the account control go later;
 * neither is rendered, because nothing exists for them to lead to.
 */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="p-root">
      <style>{CSS}</style>
      <header className="p-band">
        <a className="p-brand" href="/">
          <Mark />
          <span>panelator</span>
        </a>
      </header>
      <main className="p-main">{children}</main>
    </div>
  );
}

/** The main region at its reading width, for text screens. A full-width screen leaves it out. */
export function ReadingColumn({ children }: { children: ReactNode }) {
  return <div className="p-reading">{children}</div>;
}

/* ------------------------------------------------------------------ shared pieces */

export function PageHeading(props: { eyebrow: string; title: string; lead: string; tone?: "neutral" | "danger" }) {
  return (
    <div className="p-heading">
      <p className={`p-eyebrow${props.tone === "danger" ? " danger" : ""}`}>{props.eyebrow}</p>
      <h1 tabIndex={-1}>{props.title}</h1>
      <p className="p-lead">{props.lead}</p>
    </div>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="p-actions">{children}</div>;
}

export function Button({ variant, children }: { variant: "primary" | "secondary"; children: ReactNode }) {
  return (
    <button type="button" className={`p-btn ${variant}`}>
      {children}
    </button>
  );
}

export function ButtonLink(props: { variant: "primary" | "secondary"; href: string; children: ReactNode }) {
  return (
    <a className={`p-btn ${props.variant}`} href={props.href}>
      {props.children}
    </a>
  );
}
