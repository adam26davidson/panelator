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
