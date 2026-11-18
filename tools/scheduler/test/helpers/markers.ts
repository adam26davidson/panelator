/** Every marker family the scheduler writes or reads (spec 076 AC-2); a new family is one line here. */
export const FAMILIES = [
  "panelator-finding", "panelator-security-finding", "panelator-capability", "panelator-capability-closed", "panelator-child",
  "panelator-child-blocked", "panelator-child-unblocked", "panelator-blocked-by", "panelator-unblocked-by", "panelator-blocked-until",
  "panelator-question", "panelator-telegram-answer", "panelator-reflection",
];
/** One marker of every family, one per line. */
export const ALL = FAMILIES.map((f) => `<!-- ${f}:docs/designs/x.md:a -->`).join("\n");
export const OPEN = /<!--\s*panelator-/gi;
export const matches = (text: string) => text.match(OPEN) ?? [];
