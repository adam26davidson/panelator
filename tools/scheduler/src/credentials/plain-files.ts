import { readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Notifier } from "../notify/types.ts";
import type { CredentialStore } from "./store.ts";

export type PlainFileName = "github-app-key" | "telegram-bot";
const WEEK_MS = 7 * 24 * 3_600_000;

export interface PlainFilesDeps {
  store: CredentialStore;
  paths: Partial<Record<PlainFileName, string>>;
  fromStore: ReadonlySet<string>;
  statePath: string;
  telegram: { sendReply(text: string, replyTo?: number): Promise<number> } | null;
  notifier: Notifier;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
}

/** Spec 072 AC-3 to AC-5: remind the maintainer, at most weekly, of plain credential files the service no longer reads. Throws when the files cannot be checked. */
export async function checkPlainFiles(d: PlainFilesDeps): Promise<void> {
  const index = await d.store.readIndex();
  const named: { name: PlainFileName; path: string }[] = [];
  for (const name of ["github-app-key", "telegram-bot"] as const) {
    const path = d.paths[name];
    if (!path || !d.fromStore.has(name) || !index[name]) continue;
    try {
      if (!(await stat(path)).isDirectory()) named.push({ name, path });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!named.length) {
    await rm(d.statePath, { force: true });
    return;
  }
  const files = named.map((n) => n.path);
  const now = d.now();
  let state: { sent_at?: string; files?: string[] } | null = null;
  try {
    state = JSON.parse(await readFile(d.statePath, "utf8"));
  } catch {
    state = null;
  }
  const sentAt = state && typeof state.sent_at === "string" ? Date.parse(state.sent_at) : NaN;
  const due =
    Number.isNaN(sentAt) ||
    !Array.isArray(state?.files) ||
    files.some((f) => !state!.files!.includes(f)) ||
    now.getTime() - sentAt >= WEEK_MS;
  if (!due) return;
  const text = [
    "panelator: these plaintext credential files are no longer read (the service reads them from the encrypted store) and can be deleted:",
    ...named.map((n) => `- ${n.path} (${n.name})`),
    "Delete them by hand; this reminder repeats weekly while one remains.",
  ].join("\n");
  if (d.telegram) {
    try {
      await d.telegram.sendReply(text);
    } catch (e) {
      d.log({ kind: "plain-files-reminder-failed", error: (e as Error).message });
      return;
    }
  }
  await d.notifier.notify({ issue: 0, gate: "credential", label: "plain-files", text });
  await writeFile(d.statePath, JSON.stringify({ sent_at: now.toISOString(), files }) + "\n");
}
