export type RequiredSection =
  | "goal"
  | "out-of-scope"
  | "acceptance-criteria"
  | "interfaces"
  | "verification"
  | "ui-design"
  | "open-decisions";

export interface ParsedSpec {
  status: string | null;
  class: string | null;
  parent: string | null;
  domain: string | null;
  derivesFrom: boolean;
  sections: Record<RequiredSection, boolean>;
  openDecisionsEmpty: boolean;
  uiScreens: string[];
  listedPaths: string[];
  missing: string[];
}

const HEADINGS: Record<RequiredSection, RegExp> = {
  goal: /^goal$/i,
  "out-of-scope": /^out of scope$/i,
  "acceptance-criteria": /^acceptance criteria$/i,
  interfaces: /^interfaces and files$/i,
  verification: /^verification$/i,
  "ui-design": /^ui design$/i,
  "open-decisions": /^open decisions$/i,
};

const UI_DOMAINS = new Set(["web-ui", "widget"]);

interface Section {
  key: RequiredSection | null;
  body: string;
}

function splitSections(text: string): Section[] {
  const out: Section[] = [];
  const lines = text.split("\n");
  let current: Section | null = null;
  for (const line of lines) {
    const h = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    if (h) {
      const title = h[1];
      const key = (Object.keys(HEADINGS) as RequiredSection[]).find((k) => HEADINGS[k].test(title)) ?? null;
      current = { key, body: "" };
      out.push(current);
    } else if (current) current.body += line + "\n";
  }
  return out;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

export function parseSpec(text: string): ParsedSpec {
  const sections = splitSections(text);
  const has = (k: RequiredSection) => sections.some((s) => s.key === k);
  const body = (k: RequiredSection) => sections.find((s) => s.key === k)?.body ?? "";

  const status = firstMatch(text, /^Status:\s*(.+)$/m);
  const cls = firstMatch(text, /^Class:\s*([a-z-]+)/m);
  const domain = firstMatch(text, /Domain:\s*([a-z-]+)/m);
  const parent = firstMatch(text, /^Parent:\s*(\S+)$/m);
  const derivesFrom = /^Derives from:/m.test(text);

  const open = body("open-decisions").replace(/\s+/g, " ").trim().toLowerCase();
  const openDecisionsEmpty = has("open-decisions") && (open === "" || open === "none" || open === "none.");

  const uiScreens = (firstMatch(body("ui-design"), /^Screens:\s*(.+)$/m) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const listedPaths = [...body("interfaces").matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1])
    .filter((p) => /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.*@-]+)*\/?$/.test(p) && (p.includes("/") || p.includes(".")));

  const missing: string[] = [];
  if (!status) missing.push("Status line");
  if (!cls || !domain) missing.push("Class and domain line");
  if (!derivesFrom) missing.push("Derives from line");
  const required: [RequiredSection, string][] = [
    ["goal", "Goal section"],
    ["out-of-scope", "Out of scope section"],
    ["acceptance-criteria", "Acceptance criteria section"],
    ["interfaces", "Interfaces and files section"],
    ["verification", "Verification section"],
    ["open-decisions", "Open decisions section"],
  ];
  for (const [k, label] of required) if (!has(k)) missing.push(label);
  if (has("acceptance-criteria") && !/AC-\d+\./.test(body("acceptance-criteria"))) missing.push("numbered AC-n criteria");
  if (domain && UI_DOMAINS.has(domain)) {
    if (!has("ui-design")) missing.push("UI design section");
    else if (uiScreens.length === 0) missing.push("UI design Screens: list");
  } else if (has("ui-design")) missing.push("UI design section present for a non-UI domain");
  if (has("open-decisions") && !openDecisionsEmpty) missing.push("Open decisions must be empty");

  return {
    status,
    class: cls,
    parent,
    domain,
    derivesFrom,
    sections: {
      goal: has("goal"),
      "out-of-scope": has("out-of-scope"),
      "acceptance-criteria": has("acceptance-criteria"),
      interfaces: has("interfaces"),
      verification: has("verification"),
      "ui-design": has("ui-design"),
      "open-decisions": has("open-decisions"),
    },
    openDecisionsEmpty,
    uiScreens,
    listedPaths,
    missing,
  };
}

const CHILDREN_HEADING = /^##\s+(?:\d+\.\s*)?children\s*$/i;
const ANY_H2 = /^##\s/;

/** Line range [start, end) of the `## Children` section, heading included; null when absent. */
function findChildrenSection(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => CHILDREN_HEADING.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !ANY_H2.test(lines[end])) end++;
  return [start, end];
}

/** The repo-relative paths of the file children on `- ` bullets under `## Children`; null when the heading is absent. */
export function parseChildren(text: string): string[] | null {
  const entries = parseChildEntries(text);
  if (!entries) return null;
  return entries.filter((e) => e.kind === "file").map((e) => e.path!);
}

/** One bullet of a `## Children` section (spec 031 AC-1). */
export interface ChildEntry {
  kind: "file" | "planned";
  /** File child: the repo-relative path. */
  path?: string;
  /** Planned child: the slug as written (validated by the design-tree check). */
  slug?: string;
  title?: string;
  brief?: string;
  after: string[];
  /** The `class:` value as written. */
  class?: string;
  /** The recorded issue number. */
  issue?: number;
  /** The `issue:` value when it is not `#<n>`. */
  issueRaw?: string;
  /** A planned bullet missing `title:` or `brief:`. */
  error?: string;
  /** 0-based line within the text. */
  line: number;
}

const PLANNED_BULLET = /^-\s+planned:\s*(\S*)\s*$/;
const KEY_LINE = /^\s{2,}(title|brief|after|class|issue):\s*(.*?)\s*$/;

/** Every bullet under `## Children`, file children and planned children; null when the heading is absent. */
export function parseChildEntries(text: string): ChildEntry[] | null {
  const lines = text.split("\n");
  const range = findChildrenSection(lines);
  if (!range) return null;
  const out: ChildEntry[] = [];
  let i = range[0] + 1;
  while (i < range[1]) {
    const line = lines[i]!;
    const pm = PLANNED_BULLET.exec(line);
    if (pm) {
      const entry: ChildEntry = { kind: "planned", slug: pm[1], after: [], line: i };
      const brief: string[] = [];
      let inBrief = false;
      i++;
      while (i < range[1] && /^\s+\S/.test(lines[i]!)) {
        const km = KEY_LINE.exec(lines[i]!);
        if (km) {
          inBrief = km[1] === "brief";
          const v = km[2]!;
          if (km[1] === "title") entry.title = v;
          else if (km[1] === "brief") brief.push(v);
          else if (km[1] === "after") entry.after = v.split(",").map((r) => r.trim()).filter(Boolean);
          else if (km[1] === "class") entry.class = v;
          else {
            const n = /^#(\d+)$/.exec(v);
            if (n) entry.issue = Number(n[1]);
            else entry.issueRaw = v;
          }
        } else if (inBrief) brief.push(lines[i]!.trim());
        i++;
      }
      const joined = brief.join(" ").replace(/\s+/g, " ").trim();
      if (joined) entry.brief = joined;
      const missing = [entry.title ? null : "title:", entry.brief ? null : "brief:"].filter(Boolean);
      if (missing.length) entry.error = `missing ${missing.join(" and ")}`;
      out.push(entry);
      continue;
    }
    const m = /^-\s+(?:`([^`\s]+)`|(\S+))(.*)$/.exec(line);
    if (m) {
      const entry: ChildEntry = { kind: "file", path: m[1] ?? m[2], after: [], line: i };
      const n = /\bissue #(\d+)/.exec(m[3] ?? "");
      if (n) entry.issue = Number(n[1]);
      out.push(entry);
    }
    i++;
  }
  return out;
}

/** `<slug>` for `specs/NNN-<slug>/spec.md`; null for any other path. */
export function childSlugOfPath(path: string): string | null {
  const m = /^specs\/\d+-([^/]+)\/spec\.md$/.exec(path);
  return m ? m[1]! : null;
}

/** The text with the `## Children` section removed. */
export function stripChildren(text: string): string {
  const lines = text.split("\n");
  const range = findChildrenSection(lines);
  if (!range) return text;
  return [...lines.slice(0, range[0]), ...lines.slice(range[1])].join("\n");
}
