// Shared markup, tokens and fixture data for the console's design stories (spec 051).
// Not a story file: every <screen>.stories.tsx composes these pieces, so the six screens use one
// token set (recorded in tokens.html) and one shell. The console package does not exist on main
// yet, so this file carries its own markup; the app's components follow it (see flow.md).
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ tokens and styles */

const CSS = `
.c-root {
  --color-border: #d5d9e0;
  --color-track: #e3e7ed;
  --color-accent-soft: #e8f0fc;
  --color-danger-soft: #fdecea;
  --color-ok-soft: #e5f4ec;
  --color-warn: #7a4100;
  --color-warn-soft: #fff3dc;
  --color-violet: #5b3fc4;
  --color-violet-soft: #efebfb;
  --color-series-1: #2a78d6;
  --color-series-2: #eb6834;
  --shadow-1: 0 1px 2px rgba(20,24,31,.06), 0 1px 3px rgba(20,24,31,.08);
  --rail-w: 208px;
  min-height: 100vh; display: flex; flex-direction: column;
  background: var(--color-surface); color: var(--color-text);
  font-family: var(--font-sans); font-size: var(--text-base); line-height: 1.45;
}
.c-root *, .c-root *::before, .c-root *::after { box-sizing: border-box; }
.c-root a { color: var(--color-accent); }
.c-root h1, .c-root h2, .c-root h3, .c-root p, .c-root ul, .c-root ol { margin: 0; }
.c-root ul, .c-root ol { padding: 0; list-style: none; }
.c-mono { font-family: var(--font-mono); font-size: var(--text-sm); }
.c-muted { color: var(--color-muted); }
.c-sm { font-size: var(--text-sm); }
.c-strong { font-weight: 600; }

/* shell */
.c-main { flex: 1; min-width: 0; padding: var(--space-4) var(--space-4) var(--space-6); }
.c-inner { max-width: 1160px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-4); }
.c-inner.c-narrow { max-width: 880px; }
.c-rail { display: none; }
.c-tabs { display: flex; background: var(--color-bg); border-top: 1px solid var(--color-border); }
.c-tab { flex: 1 1 auto; min-height: 60px; gap: 2px; min-width: 44px; padding: 0 2px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; position: relative; font-size: var(--text-sm);
  color: var(--color-muted); text-decoration: none; }
.c-root .c-tab { color: var(--color-muted); }
.c-root .c-tab[aria-current="page"] { color: var(--color-accent); font-weight: 600; }
.c-tab[aria-current="page"]::before { content: ""; position: absolute; top: 0; left: 18%; right: 18%; height: 3px;
  border-radius: 0 0 3px 3px; background: var(--color-accent); }
.c-tab-icon { position: relative; display: inline-flex; height: 22px; align-items: center; }
.c-tab-icon .c-count { position: absolute; top: -6px; left: 14px; min-width: 20px; height: 20px; box-shadow: 0 0 0 2px var(--color-bg); }
.c-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 44px; }
.c-header h1 { font-size: 24px; line-height: 1.15; font-weight: 700; min-width: 0; }
@media (min-width: 720px) { .c-header h1 { font-size: var(--text-xl); } }
.c-header-end { display: flex; align-items: center; gap: var(--space-2); }
.c-avatar { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--color-border); background: var(--color-bg);
  display: inline-flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-text); font-size: var(--text-sm); }
@media (min-width: 720px) {
  .c-root { flex-direction: row; }
  .c-tabs { display: none; }
  .c-avatar { display: none; }
  .c-rail { display: block; width: var(--rail-w); flex: none; align-self: stretch; min-height: 100vh;
    background: var(--color-bg); border-right: 1px solid var(--color-border); }
  .c-rail-inner { position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--space-1);
    min-height: 100vh; padding: var(--space-6) var(--space-3); }
  .c-brand { font-weight: 700; font-size: var(--text-base); padding: 0 var(--space-3) var(--space-4); }
  .c-brand span { display: block; font-weight: 400; color: var(--color-muted); font-size: var(--text-sm); }
  .c-nav { display: flex; align-items: center; justify-content: space-between; min-height: 44px; padding: 0 var(--space-3);
    border-radius: var(--radius-sm); text-decoration: none; }
  .c-root .c-nav { color: var(--color-text); }
  .c-root .c-nav[aria-current="page"] { background: var(--color-accent-soft); color: var(--color-accent); font-weight: 600; }
  .c-rail-foot { margin-top: auto; padding: var(--space-4) var(--space-3) 0; border-top: 1px solid var(--color-border);
    display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--text-sm); }
  .c-main { padding: var(--space-8) var(--space-6) 40px; }
  .c-inner { gap: var(--space-6); }
}
@media (min-width: 1200px) {
  .c-root { --rail-w: 240px; }
  .c-main { padding: var(--space-8) 40px 48px; }
}

/* surfaces */
.c-card { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-1); padding: var(--space-4); }
@media (min-width: 720px) { .c-card { padding: var(--space-6); } }
.c-section { display: flex; flex-direction: column; gap: var(--space-3); }
.c-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.c-section-head h2 { font-size: var(--text-lg); font-weight: 650; }
.c-list { display: flex; flex-direction: column; gap: var(--space-3); }
.c-row { display: flex; align-items: center; gap: var(--space-3); }
.c-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.c-between { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }

/* small parts */
.c-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
  font-size: var(--text-sm); font-weight: 600; line-height: 22px; white-space: nowrap;
  background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); }
.c-badge.accent { background: var(--color-accent-soft); color: var(--color-accent); border-color: transparent; }
.c-badge.ok { background: var(--color-ok-soft); color: var(--color-ok); border-color: transparent; }
.c-badge.warn { background: var(--color-warn-soft); color: var(--color-warn); border-color: transparent; }
.c-badge.danger { background: var(--color-danger-soft); color: var(--color-danger); border-color: transparent; }
.c-badge.violet { background: var(--color-violet-soft); color: var(--color-violet); border-color: transparent; }
.c-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 999px; background: var(--color-danger); color: #fff; font-size: var(--text-sm); font-weight: 700; line-height: 1; }
.c-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.c-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: 44px;
  padding: 0 var(--space-4); border-radius: var(--radius-sm); border: 1px solid var(--color-border);
  background: var(--color-bg); color: var(--color-text); font: inherit; font-size: var(--text-sm); font-weight: 600;
  text-decoration: none; white-space: nowrap; cursor: pointer; }
.c-root a.c-btn { color: var(--color-text); }
.c-btn.primary, .c-root a.c-btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
.c-btn.danger { color: var(--color-danger); }
.c-btn[disabled] { background: var(--color-surface); color: var(--color-muted); border-color: var(--color-border); cursor: default; }
.c-link { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: var(--text-sm); font-weight: 600;
  text-decoration: none; }
@media (min-width: 720px) { .c-link { min-height: 32px; } }
.c-kv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.c-kv dt { font-size: var(--text-sm); color: var(--color-muted); }
.c-kv dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.c-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--color-accent-soft); border-top-color: var(--color-accent); flex: none; }
.c-note { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-3); border-radius: var(--radius-sm);
  font-size: var(--text-sm); }
.c-note.pending { background: var(--color-accent-soft); color: var(--color-accent); }
.c-note.refused { background: var(--color-danger-soft); color: var(--color-danger); }
.c-note.locked { background: var(--color-surface); color: var(--color-muted); }

/* freshness and failure */
.c-fresh { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: 999px;
  font-size: var(--text-sm); font-weight: 600; white-space: nowrap; background: var(--color-ok-soft); color: var(--color-ok); }
.c-fresh.stale { background: var(--color-warn-soft); color: var(--color-warn); }
.c-fresh.offline { background: var(--color-danger-soft); color: var(--color-danger); }
.c-fresh.loading { background: var(--color-track); color: var(--color-muted); }
.c-alert { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border-radius: var(--radius-md);
  border: 1px solid; font-size: var(--text-sm); }
.c-alert strong { font-size: var(--text-base); display: block; margin-bottom: 2px; }
.c-alert.stale { background: var(--color-warn-soft); color: var(--color-warn); border-color: #f0d4a4; }
.c-alert.offline { background: var(--color-danger-soft); color: var(--color-danger); border-color: #f4c1bc; }
@media (min-width: 720px) { .c-alert { flex-direction: row; align-items: center; justify-content: space-between; } }

/* skeleton */
.c-skel { background: var(--color-track); border-radius: var(--radius-sm); }

/* home */
.c-qbanner { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md); background: var(--color-violet); color: #fff; text-decoration: none; }
.c-root a.c-qbanner { color: #fff; }
.c-qbanner .c-count { background: #fff; color: var(--color-violet); }
.c-qbanner span.grow { flex: 1; font-weight: 600; }
.c-home { display: grid; gap: var(--space-4); grid-template-columns: minmax(0, 1fr); }
.c-home > .full { grid-column: 1 / -1; }
.c-tiles { display: grid; gap: var(--space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (min-width: 720px) { .c-home { gap: var(--space-6); } .c-tiles { gap: var(--space-4); } }
@media (min-width: 1200px) {
  .c-home { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .c-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.c-current h2 { font-size: var(--text-lg); line-height: 1.3; font-weight: 650; }
.c-eyebrow { font-size: var(--text-sm); font-weight: 600; color: var(--color-muted); }
.c-stages { display: grid; gap: 4px; }
.c-seg { height: 10px; border-radius: 5px; background: var(--color-track); }
.c-seg.done { background: var(--color-ok); }
.c-seg.running { background: var(--color-accent); }
.c-seg.failed { background: var(--color-danger); }
.c-stage-labels { display: none; }
.c-stage-caption { font-size: var(--text-sm); }
@media (min-width: 720px) {
  .c-stage-labels { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--color-muted); }
  .c-stage-labels .running { color: var(--color-accent); font-weight: 700; }
  .c-stage-labels .failed { color: var(--color-danger); font-weight: 700; }
  .c-stage-labels .done { color: var(--color-ok); }
  .c-stage-caption { display: none; }
}
.c-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin: 0; }
.c-meta > :first-child { grid-column: 1 / -1; }
@media (min-width: 720px) { .c-meta { grid-template-columns: repeat(3, minmax(0, 1fr)); } .c-meta > :first-child { grid-column: auto; } }
.c-claim { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: var(--space-2) var(--space-4);
  background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); text-decoration: none; }
.c-root a.c-claim { color: var(--color-text); }
.c-claim .grow, .c-next .grow { flex: 1; min-width: 0; }
.c-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-next { display: flex; align-items: center; gap: var(--space-3); min-height: 52px; padding: var(--space-2) 0; border-top: 1px solid var(--color-border); }
.c-next:first-child { border-top: 0; }
.c-tile { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); min-height: 148px;
  background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-1);
  text-decoration: none; }
.c-root a.c-tile { color: var(--color-text); }
.c-tile .label { font-size: var(--text-sm); color: var(--color-muted); font-weight: 600; display: flex; justify-content: space-between; gap: var(--space-2); }
.c-tile .value { font-size: var(--text-xl); font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.c-tile .value small { font-size: var(--text-sm); font-weight: 600; color: var(--color-muted); margin-left: 4px; }
.c-tile .value.none { font-size: var(--text-lg); color: var(--color-muted); }
.c-meter { position: relative; height: 10px; border-radius: 5px; background: var(--color-track); margin-top: auto; }
.c-meter .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--color-series-1); }
.c-meter .mark { position: absolute; top: -4px; bottom: -4px; width: 3px; border-radius: 2px; background: var(--color-text); }

/* charts */
.c-chart { position: relative; height: 168px; margin: var(--space-2) 0 0 44px; }
.c-chart.spark { height: 36px; margin: auto 0 0; }
.c-chart svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.c-grid { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--color-track); }
.c-ylab { position: absolute; left: -44px; width: 38px; text-align: right; transform: translateY(-50%);
  font-size: var(--text-sm); color: var(--color-muted); font-variant-numeric: tabular-nums; }
.c-xlabs { position: relative; height: 24px; margin-left: 44px; }
.c-xlab { position: absolute; top: 4px; transform: translateX(-50%); font-size: var(--text-sm); color: var(--color-muted); white-space: nowrap; }
.c-xlab.first { transform: none; }
.c-xlab.last { transform: translateX(-100%); }
.c-pt { position: absolute; width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%);
  box-shadow: 0 0 0 2px var(--color-bg); }
.c-cross { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed var(--color-muted); }
.c-tip { position: absolute; top: 4px; transform: translateX(-104%); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
  background: var(--color-text); color: #fff; font-size: var(--text-sm); white-space: nowrap; box-shadow: var(--shadow-1); }
.c-legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-sm); color: var(--color-text); }
.c-key { display: inline-flex; align-items: center; gap: 6px; }
.c-key i { display: inline-block; width: 18px; height: 0; border-top: 2px solid; }
.c-key i.dash { border-top-style: dashed; }
.c-seg-ctl { align-self: flex-start; display: inline-flex; padding: 3px; gap: 3px; border-radius: var(--radius-sm); background: var(--color-track); }
.c-seg-ctl button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; min-width: 56px; padding: 0 var(--space-3); border: 0; border-radius: 5px; background: transparent;
  font: inherit; font-size: var(--text-sm); font-weight: 600; color: var(--color-muted); }
.c-seg-ctl button[aria-pressed="true"] { background: var(--color-bg); color: var(--color-text); box-shadow: var(--shadow-1); }
.c-seg-ctl button[aria-pressed="true"].locked { color: var(--color-warn); }
.c-seg-ctl button[aria-pressed="true"].auto { color: var(--color-accent); }
.c-charts { display: grid; gap: var(--space-4); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1200px) { .c-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); } }
.c-focus { outline: 3px solid var(--color-accent); outline-offset: 2px; }
.c-trow.c-focus { outline-offset: -3px; background: var(--color-accent-soft); }
@media (min-width: 720px) and (max-width: 1199px) {
  .c-trow.c-params-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: var(--space-6); }
  .c-trow.c-params-grid > :first-child, .c-trow.c-params-grid > :last-child { grid-column: 1 / -1; }
}

/* table-like lists on wide screens */
.c-trow { display: grid; gap: var(--space-3); padding: var(--space-4); border-top: 1px solid var(--color-border); }
.c-trow:first-child { border-top: 0; }
.c-thead { display: none; }
.c-tbody { padding: 0; overflow: hidden; }
@media (min-width: 720px) { .c-trow { padding: var(--space-4) var(--space-6); } }
.c-actions-grid { grid-template-columns: minmax(0, 1fr); }
.c-agents-grid { grid-template-columns: minmax(0, 1fr); }
.c-params-grid { grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1200px) {
  .c-thead { display: grid; padding: var(--space-3) var(--space-6); font-size: var(--text-sm); font-weight: 600; color: var(--color-muted);
    background: var(--color-surface); border-bottom: 1px solid var(--color-border); }
  .c-actions-grid { grid-template-columns: 132px minmax(0, 1fr) 140px 168px 128px; align-items: start; }
  .c-agents-grid { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr) 120px 150px; align-items: center; }
  .c-params-grid { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.1fr) 230px minmax(0, .9fr); align-items: start; }
  .c-only-narrow { display: none !important; }
}
@media (max-width: 1199px) { .c-only-wide { display: none !important; } }
.c-field { display: flex; gap: var(--space-2); align-items: center; }
.c-input { min-height: 44px; width: 120px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  font: inherit; font-size: var(--text-base); background: var(--color-bg); color: var(--color-text); font-variant-numeric: tabular-nums; }
.c-input.wide { width: 200px; }
.c-input.edited { border-color: var(--color-accent); box-shadow: 0 0 0 1px var(--color-accent); }
.c-input.bad { border-color: var(--color-danger); box-shadow: 0 0 0 1px var(--color-danger); }
.c-input[readonly] { background: var(--color-surface); }

/* sign-in */
.c-signin { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-6) var(--space-4);
  background: var(--color-surface); }
.c-signin .c-card { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: var(--space-4); text-align: center; padding: var(--space-8) var(--space-6); }
.c-signin h1 { font-size: var(--text-xl); font-weight: 700; line-height: 1.2; }
.c-gh { background: #14181f; border-color: #14181f; color: #fff; min-height: 48px; font-size: var(--text-base); }
.c-root a.c-gh, a.c-btn.c-gh { color: #fff; }

/* empty */
.c-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-2); padding: var(--space-8) var(--space-4); }
.c-empty .icon { width: 48px; height: 48px; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent);
  display: flex; align-items: center; justify-content: center; margin-bottom: var(--space-2); }
.c-empty h3 { font-size: var(--text-lg); }
.c-empty p { color: var(--color-muted); max-width: 440px; }
`;

/* ------------------------------------------------------------------ icons */

const svg = (d: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export const Icon = {
  chevron: (s?: number) => svg(<path d="m9 6 6 6-6 6" />, s),
  external: (s?: number) => svg(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>, s),
  lock: (s?: number) => svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, s),
  check: (s?: number) => svg(<path d="m5 12 5 5 9-10" />, s),
  x: (s?: number) => svg(<><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>, s),
  alert: (s?: number) => svg(<><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4" /><path d="M12 17v.5" /></>, s),
  cloudOff: (s?: number) => svg(<><path d="M3 3l18 18" /><path d="M7 18h10a4 4 0 0 0 1.5-.3M20.6 14.5A4 4 0 0 0 17 9h-.5A6 6 0 0 0 9 5.3M5.5 8.5A5 5 0 0 0 7 18" /></>, s),
  undo: (s?: number) => svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>, s),
  pause: (s?: number) => svg(<><path d="M9 5v14" /><path d="M15 5v14" /></>, s),
  play: (s?: number) => svg(<path d="M7 4v16l13-8z" />, s),
  inbox: (s?: number) => svg(<><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>, s),
  home: (s?: number) => svg(<><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>, s),
  list: (s?: number) => svg(<><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>, s),
  bot: (s?: number) => svg(<><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><path d="M9 14h.01M15 14h.01" /></>, s),
  sliders: (s?: number) => svg(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>, s),
  question: (s?: number) => svg(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></>, s),
  chart: (s?: number) => svg(<><path d="M4 20V4" /><path d="M4 20h16" /><path d="m7 15 4-5 3 3 5-7" /></>, s),
  github: (s?: number) => (
    <svg width={s ?? 20} height={s ?? 20} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ shell */

export type ScreenName = "home" | "questions" | "history" | "actions" | "agents" | "parameters";
export const SCREENS: { id: ScreenName; label: string; short: string }[] = [
  { id: "home", label: "Home", short: "Home" },
  { id: "questions", label: "Questions", short: "Questions" },
  { id: "history", label: "History", short: "History" },
  { id: "actions", label: "Actions", short: "Actions" },
  { id: "agents", label: "Agents", short: "Agents" },
  { id: "parameters", label: "Parameters", short: "Params" },
];

const TAB_ICON: Record<ScreenName, (s?: number) => ReactNode> = {
  home: Icon.home, questions: Icon.question, history: Icon.chart, actions: Icon.list, agents: Icon.bot, parameters: Icon.sliders,
};

/** What the app knows about its snapshot: fresh, stale (older than 3 x tick_s), offline (API unreachable) or loading. */
export type Freshness = "fresh" | "stale" | "offline" | "loading";

export function FreshChip({ state }: { state: Freshness }) {
  if (state === "loading") return <span className="c-fresh loading"><span className="c-spin" />Loading</span>;
  if (state === "stale") return <span className="c-fresh stale"><span className="c-dot" />Stale · 4 min old</span>;
  if (state === "offline") return <span className="c-fresh offline"><span className="c-dot" />Offline · 6 min old</span>;
  return <span className="c-fresh"><span className="c-dot" />Updated 18 s ago</span>;
}

export function FreshAlert({ state }: { state: Freshness }) {
  if (state === "stale")
    return (
      <div className="c-alert stale" role="status">
        <div>
          <strong>This snapshot is 4 minutes old</strong>
          The scheduler pushes at least every 60 s, so it may be stopped or offline. Shown as of 10:40. Changes you make
          wait in the queue until it reconnects.
        </div>
      </div>
    );
  if (state === "offline")
    return (
      <div className="c-alert offline" role="alert">
        <div>
          <strong>Can't reach the console API</strong>
          Showing the last snapshot it sent (10:38, 6 min ago). Retrying every 10 s. Changes are off until it is back.
        </div>
        <button type="button" className="c-btn">Retry now</button>
      </div>
    );
  return null;
}

export function Shell({ screen, fresh = "fresh", openQuestions = 2, narrow, title, children }: {
  screen: ScreenName;
  fresh?: Freshness;
  openQuestions?: number;
  narrow?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  return (
    <div className="c-root">
      <style>{CSS}</style>
      <nav className="c-rail" aria-label="Console">
        <div className="c-rail-inner">
          <div className="c-brand">panelator<span>maintainer console</span></div>
          {SCREENS.map((s) => (
            <a key={s.id} className="c-nav" href={`#${s.id}`} aria-current={s.id === screen ? "page" : undefined}>
              {s.label}
              {s.id === "questions" && openQuestions > 0 ? <span className="c-count">{openQuestions}</span> : null}
            </a>
          ))}
          <div className="c-rail-foot">
            <span className="c-muted">Signed in as</span>
            <span className="c-strong">@maintainer</span>
            <button type="button" className="c-btn" style={{ alignSelf: "flex-start" }}>Sign out</button>
          </div>
        </div>
      </nav>
      <main className="c-main">
        <div className={`c-inner${narrow ? " c-narrow" : ""}`}>
          <header className="c-header">
            <h1>{title ?? label}</h1>
            <div className="c-header-end">
              <FreshChip state={fresh} />
              <button type="button" className="c-avatar" aria-label="Account: @maintainer">M</button>
            </div>
          </header>
          <FreshAlert state={fresh} />
          {children}
        </div>
      </main>
      <nav className="c-tabs" aria-label="Console">
        {SCREENS.map((s) => (
          <a key={s.id} className="c-tab" href={`#${s.id}`} aria-current={s.id === screen ? "page" : undefined}>
            <span className="c-tab-icon">
              {TAB_ICON[s.id](22)}
              {s.id === "questions" && openQuestions > 0 ? <span className="c-count">{openQuestions}</span> : null}
            </span>
            {s.short}
          </a>
        ))}
      </nav>
    </div>
  );
}

export function SignIn({ screen }: { screen: ScreenName }) {
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  return (
    <div className="c-root">
      <style>{CSS}</style>
      <div className="c-signin">
        <div className="c-card">
          <div className="c-eyebrow">panelator · maintainer console</div>
          <h1>Sign in to see {label}</h1>
          <p className="c-muted">Your session has ended or you have not signed in on this device. Only the maintainer's GitHub login can sign in.</p>
          <a className="c-btn c-gh" href="#auth-login">{Icon.github()} Sign in with GitHub</a>
          <p className="c-sm c-muted">After sign-in you return to {label}.</p>
        </div>
      </div>
    </div>
  );
}

export function SignInRefused() {
  return (
    <div className="c-root">
      <style>{CSS}</style>
      <div className="c-signin">
        <div className="c-card">
          <div className="c-eyebrow">panelator · maintainer console</div>
          <h1>This login can't use the console</h1>
          <div className="c-note refused" style={{ textAlign: "left" }}>
            {Icon.x()}
            <span>GitHub signed you in as <b>@someone-else</b>. The console admits only the maintainer's login, and this attempt has been recorded.</span>
          </div>
          <a className="c-btn" href="#auth-login">{Icon.github()} Sign in with a different GitHub account</a>
        </div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="c-card c-empty">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Skel({ h = 16, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="c-skel" style={{ height: h, width: w, borderRadius: r }} />;
}

export function Pending({ children }: { children: ReactNode }) {
  return <div className="c-note pending" role="status"><span className="c-spin" style={{ marginTop: 2 }} /><span>{children}</span></div>;
}

export function Refused({ children }: { children: ReactNode }) {
  return <div className="c-note refused" role="alert"><span style={{ flex: "none" }}>{Icon.x()}</span><span>{children}</span></div>;
}

/* ------------------------------------------------------------------ charts */

type Series = { name: string; values: (number | null)[]; color: string; dashed?: boolean };

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
export function LineChart({ series, weeks, yMax, yTicks, fmt = (n: number) => String(n), spark, hover }: {
  series: Series[];
  weeks: string[];
  yMax: number;
  yTicks?: number[];
  fmt?: (n: number) => string;
  spark?: boolean;
  hover?: { index: number; lines: string[] };
}) {
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / yMax) * 100;
  const ticks = yTicks ?? [0, yMax / 2, yMax];
  const labelIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1];
  return (
    <div>
      <div className={`c-chart${spark ? " spark" : ""}`}>
        {!spark && ticks.map((t) => (
          <div key={t}>
            <div className="c-grid" style={{ top: `${y(t)}%` }} />
            <div className="c-ylab" style={{ top: `${y(t)}%` }}>{fmt(t)}</div>
          </div>
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {series.map((s) =>
            segments(s.values).filter((seg) => seg.length > 1).map((seg) => (
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
            const marks = seg.length === 1 ? seg : seg[seg.length - 1][0] === s.values.length - 1 ? [seg[seg.length - 1]] : [];
            return marks.map(([i, v]) => (
              <span key={`${s.name}-p${i}`} className="c-pt" style={{ left: `${x(i)}%`, top: `${y(v)}%`, background: s.color }} />
            ));
          }),
        )}
        {hover ? (
          <>
            <div className="c-cross" style={{ left: `${x(hover.index)}%` }} />
            {series.map((s) => {
              const v = s.values[hover.index];
              return v === null || v === undefined ? null : (
                <span key={`h-${s.name}`} className="c-pt" style={{ left: `${x(hover.index)}%`, top: `${y(v)}%`, background: s.color, width: 10, height: 10 }} />
              );
            })}
            <div className="c-tip" style={{ left: `${x(hover.index)}%` }}>
              {hover.lines.map((l, i) => <div key={l} style={{ fontWeight: i === 0 ? 600 : 400 }}>{l}</div>)}
            </div>
          </>
        ) : null}
      </div>
      {!spark ? (
        <div className="c-xlabs">
          {labelIdx.map((i, k) => (
            <span key={i} className={`c-xlab${k === 0 ? " first" : k === labelIdx.length - 1 ? " last" : ""}`} style={{ left: `${x(i)}%` }}>{weeks[i]}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ fixture snapshot (console-state, spec 051 AC-2) */

/** Week labels (Monday of each ISO week) for the last 12 complete weeks. */
export const WEEKS_12 = ["18 Aug", "25 Aug", "1 Sep", "8 Sep", "15 Sep", "22 Sep", "29 Sep", "6 Oct", "13 Oct", "20 Oct", "27 Oct", "3 Nov"];

export const METRICS = [
  {
    name: "merged_per_week", label: "Merged per week", goal: "delivery", unit: "PRs", direction: "higher",
    description: "Pull requests merged into main per week.", yMax: 12,
    values: [3, 4, null, 5, 6, 4, 7, 8, 6, 9, 7, 9], fmt: (n: number) => String(n),
  },
  {
    name: "issue_to_merge_days", label: "Median issue-to-merge", goal: "speed", unit: "days", direction: "lower",
    description: "Median days from an issue's first claim to its PR's merge.", yMax: 6,
    values: [5.1, 4.6, null, 4.2, 3.9, 4.4, 3.1, 2.9, 3.3, 2.6, 2.8, 2.4], fmt: (n: number) => n.toFixed(1),
  },
  {
    name: "rework_per_merge", label: "Rework", goal: "quality", unit: "fix rounds per merge", direction: "lower",
    description: "Fix rounds a pull request needed before it merged.", yMax: 1.5,
    values: [1.1, 0.9, null, 0.8, 0.7, 0.9, 0.6, 0.5, 0.6, 0.4, 0.5, 0.3], fmt: (n: number) => n.toFixed(1),
  },
] as const;

/** A replaced metric and its replacement, carried side by side while the report has both (spec 027 AC-5). */
export const REPLACED = {
  name: "cost_per_merge_usd", label: "Cost per merge", goal: "spend", unit: "USD", direction: "lower",
  description: "Model and AWS spend per merged pull request.", yMax: 8,
  replaces: "claude_cost_per_merge_usd", overlapDaysLeft: 23,
  values: [null, null, null, null, null, null, null, null, 4.9, 4.2, 4.6, 3.8],
  old: [5.8, 5.2, null, 6.1, 5.0, 5.4, 4.7, 4.4, 4.5, 3.9, 4.3, 3.6],
};

export const QUESTIONS = [
  {
    id: 3012, issue: 112, kind: "product", status: "open", asked: "asked 2 h ago",
    text: "Should a widget be allowed to fetch from any HTTPS host, or only from hosts listed in its manifest?",
    options: [
      { label: "Any HTTPS host", cost: "simplest for widget authors; the panel's traffic is not bounded" },
      { label: "Only manifest hosts", cost: "authors declare hosts; one more review step per widget" },
    ],
    recommendation: "Only manifest hosts",
  },
  {
    id: 2987, issue: 101, kind: "capability", status: "reminded", asked: "asked 2 d ago · reminded 3 h ago",
    text: "The console needs a GitHub OAuth app for sign-in. Create it and reply with the client id (steps in spec 051 section 9).",
    options: [{ label: "Reply with the client id", cost: "about 5 minutes on GitHub and one aws ssm command" }],
    recommendation: null,
  },
];

export const ANSWERED = [
  { id: 2951, issue: 94, kind: "technical", answered: "answered 4 d ago", text: "Store recorded events in SQLite on the laptop, or in DynamoDB in the delivery account?" },
  { id: 2890, issue: 77, kind: "product", answered: "answered 9 d ago", text: "Should the panel show a widget's last good frame when its data source fails, or a placeholder?" },
  { id: 2806, issue: 61, kind: "capability", answered: "answered 15 d ago", text: "Create the delivery AWS account and the PanelatorDelivery permission set (spec 022 section 8)." },
];

export const CURRENT = {
  issue: 97, title: "Event store retention and compaction", model: "claude-opus-5-5", elapsed: "42 min", cost: "$3.18", pr: 205,
  stages: [
    { name: "plan", status: "done" }, { name: "implement", status: "running" }, { name: "verify", status: "pending" },
    { name: "review", status: "pending" }, { name: "fix", status: "pending" }, { name: "merge", status: "pending" },
  ],
};
export const OTHER_CLAIMS = [
  { issue: 101, title: "Specify and build the maintainer console", stage: "design", elapsed: "12 min", cost: "$0.41", pr: null as number | null },
];
export const UP_NEXT = [
  { issue: 118, title: "Widget host allowlist in the manifest schema", cls: "product" },
  { issue: 109, title: "Firmware: reconnect Wi-Fi without a reboot", cls: "product" },
  { issue: 104, title: "Standing agent for dependency updates", cls: "tooling" },
  { issue: 99, title: "Telegram reminders respect quiet hours", cls: "tooling" },
];

export type ActionRow = {
  id: string; when: string; agent: string; what: string; why: string;
  status: "applied" | "undone" | "refused" | "failed" | "pending"; undoable: boolean; reason?: string;
};
export const ACTIONS: ActionRow[] = [
  { id: "a-0193", when: "today 09:14", agent: "action-audit", what: "Set slots 1 → 2", why: "Queue has held 6+ ready issues for 3 days and quota use is under 40%.", status: "applied", undoable: true },
  { id: "a-0192", when: "today 07:02", agent: "findings-filer", what: "Pause agent reflection", why: "Its last 3 runs failed on a missing metrics report; resumes when spec 027 lands.", status: "applied", undoable: true },
  { id: "a-0191", when: "yesterday 22:40", agent: "maintainer", what: "Set standing.event_debounce 6h → 2h", why: "Set from the console (change 41).", status: "applied", undoable: true },
  { id: "a-0190", when: "yesterday 18:05", agent: "action-audit", what: "Set system_work_share 0.75 → 0.7", why: "Two product issues have waited longer than any system issue.", status: "undone", undoable: false },
  { id: "a-0189", when: "5 Nov 11:30", agent: "action-audit", what: "Set aws_cap_usd 0 → 3", why: "Spec 051 needs hosting.", status: "refused", undoable: false, reason: "aws_cap_usd is locked: only the maintainer can change it." },
  { id: "a-0188", when: "4 Nov 16:12", agent: "findings-filer", what: "Resume agent action-audit", why: "The pause reason (issue #88) was fixed in PR #191.", status: "applied", undoable: true },
];

export type AgentRow = { name: string; summary: string; last: string; lastOk: boolean; next: string; cost: string; paused: null | "maintainer" | string };
export const AGENTS: AgentRow[] = [
  { name: "findings-filer", summary: "Files queued findings as issues", last: "today 10:02 · ok", lastOk: true, next: "today 16:02", cost: "$4.12", paused: null },
  { name: "action-audit", summary: "Reviews direct actions taken by agents", last: "today 06:00 · ok", lastOk: true, next: "tomorrow 06:00", cost: "$1.87", paused: null },
  { name: "reflection", summary: "Weekly reflection on the metrics", last: "3 Nov 08:00 · failed", lastOk: false, next: "paused", cost: "$0.96", paused: "findings-filer" },
  { name: "dependency-watch", summary: "Checks toolchain updates", last: "1 Nov 09:00 · ok", lastOk: true, next: "paused", cost: "$0.22", paused: "maintainer" },
];

export type ParamRow = {
  name: string; type: "number" | "boolean" | "duration" | "string"; value: string; mode: "auto" | "locked";
  min?: string; max?: string; description: string; setBy: string; at: string;
};
export const PARAMS: ParamRow[] = [
  { name: "aws_cap_usd", type: "number", value: "0", mode: "locked", min: "0", description: "Maximum AWS spend per month in USD. At 0 every reservation is refused.", setBy: "maintainer", at: "15 Oct" },
  { name: "system_work_share", type: "number", value: "0.75", mode: "auto", min: "0", max: "1", description: "Target share of system rather than product work.", setBy: "maintainer", at: "6 Nov" },
  { name: "slots", type: "number", value: "2", mode: "auto", min: "1", max: "4", description: "Concurrent runs.", setBy: "action-audit", at: "today 09:14" },
  { name: "standing.event_debounce", type: "duration", value: "2h", mode: "auto", min: "0m", max: "30d", description: "How long a queued finding waits after a standing agent's last run before it starts another; 0m turns it off.", setBy: "maintainer", at: "yesterday" },
  { name: "first_contact_needs_approval", type: "boolean", value: "true", mode: "locked", description: "Require approval for first contact with an outside party.", setBy: "maintainer", at: "15 Oct" },
  { name: "quota.model_limit_fallback", type: "boolean", value: "true", mode: "auto", description: "When only a strong-tier stage's own model is limited, run it on the fallback model instead of waiting.", setBy: "default", at: "29 Oct" },
  { name: "quota.model_limit_fallback_model", type: "string", value: "claude-opus-5-5", mode: "auto", description: "The model a strong-tier stage moves to under a model-specific limit.", setBy: "default", at: "29 Oct" },
  { name: "quota.session_window", type: "duration", value: "5h", mode: "auto", min: "1h", max: "24h", description: "Length of a Claude subscription session window, from its first run.", setBy: "default", at: "29 Oct" },
];
