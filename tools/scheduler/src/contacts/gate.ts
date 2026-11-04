import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionLog } from "../actions/log.ts";
import { withStateLock } from "../parameters/store.ts";
import type { ParameterStore } from "../parameters/store.ts";
import type { StatePaths } from "../state/paths.ts";

export interface Party {
  party: string;
  channel: string;
  approved_at: string;
  question_comment_id: number | null;
  issue: number;
}

export async function readParties(paths: StatePaths): Promise<Party[]> {
  try {
    return JSON.parse(await readFile(paths.contactParties, "utf8")) as Party[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeParties(paths: StatePaths, parties: Party[]): Promise<void> {
  await mkdir(dirname(paths.contactParties), { recursive: true });
  await writeFile(paths.contactParties + ".tmp", JSON.stringify(parties, null, 2) + "\n");
  await rename(paths.contactParties + ".tmp", paths.contactParties);
}

/** Spec 030 AC-8: only the scheduler's answer handling and the maintainer's command write this file; no action kind does. */
export async function approveParty(paths: StatePaths, p: Party): Promise<void> {
  await mkdir(dirname(paths.contactParties), { recursive: true });
  await withStateLock(paths.contactParties, async () => {
    const parties = await readParties(paths);
    if (!parties.some((x) => x.party === p.party)) await writeParties(paths, [...parties, p]);
  });
}

export async function removeParty(paths: StatePaths, party: string): Promise<boolean> {
  await mkdir(dirname(paths.contactParties), { recursive: true });
  return withStateLock(paths.contactParties, async () => {
    const parties = await readParties(paths);
    const rest = parties.filter((p) => p.party !== party);
    if (rest.length === parties.length) return false;
    await writeParties(paths, rest);
    return true;
  });
}

export type ContactCheck = { allowed: true } | { allowed: false; text: string };

/** Spec 030 AC-11: the parameter is read at each call; the system cannot change it (spec 008 AC-12). */
export async function checkContact(ctx: { paths: StatePaths; parameters: ParameterStore }, party: string): Promise<ContactCheck> {
  if ((await ctx.parameters.read("first_contact_needs_approval")).value === false) return { allowed: true };
  if ((await readParties(ctx.paths)).some((p) => p.party === party)) return { allowed: true };
  return {
    allowed: false,
    text: `panelator: first contact with ${party} needs the maintainer's approval and none is recorded. Raise a capability question with a first_contact request (party, channel, why, message: the full text you would send), then retry after it is approved. No call was made.`,
  };
}

const READ_VERBS = new Set(["view", "list", "status", "diff", "checks", "checkout", "download", "browse", "clone", "get", "watch"]);
const ownerOf = (repo: string): string => repo.split("/").filter(Boolean).slice(-2)[0] ?? repo;

/**
 * Which gh invocations reach another repository with a write. Returns the party and the command without its
 * body (the subcommand words and the repository only), or null when the call is a read or stays in `repo`.
 */
export function classifyGh(argv: readonly string[], repo: string): { party: string; command: string } | null {
  const words: string[] = [];
  let target: string | null = null;
  let method: string | null = null;
  let hasBody = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (flag: string): string | null => (a === flag ? (argv[++i] ?? null) : a.startsWith(flag + "=") ? a.slice(flag.length + 1) : null);
    let v: string | null;
    if ((v = val("-R")) !== null || (v = val("--repo")) !== null) target = v;
    else if ((v = val("-X")) !== null || (v = val("--method")) !== null) method = v.toUpperCase();
    else if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a)) {
      hasBody = true;
      if (!a.includes("=")) i++;
    } else if (/^-[a-zA-Z]$|^--/.test(a)) {
      /* other flags: their values are never repository names, and are skipped when a separate token */
    } else if (words.length < 3) words.push(a);
  }
  const [group, verb] = words;
  const other = (r: string) => r.replace(/^https?:\/\/[^/]+\//, "").split("/").slice(-2).join("/").toLowerCase() !== repo.toLowerCase();
  if (group === "api") {
    const path = words[1]?.replace(/^\//, "");
    const m = /^repos\/([^/]+)\/([^/?]+)/.exec(path ?? "");
    const write = (method ?? (hasBody ? "POST" : "GET")) !== "GET";
    if (!m || !write || !other(`${m[1]}/${m[2]}`)) return null;
    return { party: `github:${m[1]}`, command: `gh api ${method ?? "POST"} /repos/${m[1]}/${m[2]}` };
  }
  if (group === "repo" && verb === "fork") {
    const t = target ?? words[2];
    return t ? { party: `github:${ownerOf(t)}`, command: `gh repo fork ${t}` } : null;
  }
  if (target !== null && other(target) && !(verb && READ_VERBS.has(verb))) return { party: `github:${ownerOf(target)}`, command: `gh ${group ?? ""} ${verb ?? ""} -R ${target}`.replace(/ +/g, " ") };
  return null;
}

export async function recordRefusal(log: ActionLog, agent: string, party: string, command: string): Promise<void> {
  const row = await log.writePending({ agent, run_id: "gh-shim", kind: "contact_refused", args: { party, command }, why: "first contact without an approved party", undo: null });
  await log.settle(row.id, "refused", `no approval for ${party}`);
}
