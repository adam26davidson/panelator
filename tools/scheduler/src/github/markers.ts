/**
 * The scheduler recognises its own records on GitHub by a hidden `<!-- panelator-<family>:... -->` marker in a body or
 * comment the App authored. The rule for every writer of such text, today and in future (spec 076 AC-2): pass all the
 * text you post through `neutraliseMarkers`, then append only your own marker after it.
 */
const MARKER_START = /<!--\s*panelator-/i;
const MARKER_START_ALL = /<!--\s*panelator-/gi;

/** Rewrites every `<!-- panelator-` to `<!-- ` until none is left, so a rewrite never leaves a marker behind (AC-1). */
export function neutraliseMarkers(text: string): string {
  let out = text;
  while (MARKER_START.test(out)) out = out.replace(MARKER_START_ALL, "<!-- ");
  return out;
}
