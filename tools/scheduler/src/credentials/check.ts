import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TelegramClient } from "../telegram/client.ts";
import type { StatePaths } from "../state/paths.ts";
import type { Catalogue, CatalogueEntry } from "./catalogue.ts";
import type { CredentialStore, IndexEntry } from "./store.ts";

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (command: string, env: Record<string, string>, timeoutMs: number) => Promise<RunResult>;

export const defaultRunner: Runner = (command, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile("sh", ["-c", command], { env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout, stderr });
    });
  });

export interface CredDeps {
  store: CredentialStore;
  catalogue: Catalogue;
  paths: StatePaths;
  binDir: string;
  now: () => Date;
  run?: Runner;
  telegramBaseUrl?: string;
  timeoutMs?: number;
}

export type CheckOutcome = { name: string; status: "ok" | "missing" | `failed: ${string}`; expires_at: string | null };

const scrub = (text: string, secret: string) => (secret ? text.split(secret).join("***") : text);

/** The environment a check or probe runs in: the `gh` shim first on PATH, the secret in the wrapper's variable only. */
function envFor(d: CredDeps, e: CatalogueEntry, secret: string): Record<string, string> {
  const env: Record<string, string> = { PATH: `${d.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, PANELATOR_STATE_DIR: d.paths.root, HOME: process.env.HOME ?? "" };
  if (e.wrapper !== "none") env[e.wrapper.env] = secret;
  return env;
}

async function builtin(d: CredDeps, name: string, secret: string): Promise<string | null> {
  if (name === "telegram-get-me") {
    try {
      const c = JSON.parse(secret) as { bot_token: string; chat_id: number };
      await new TelegramClient(c.bot_token, c.chat_id, d.telegramBaseUrl).getMe();
      return null;
    } catch {
      return "getMe failed";
    }
  }
  return `unknown builtin check ${name}`;
}

/** null when the credential works, else the reason (never containing the secret). */
export async function runCheck(d: CredDeps, e: CatalogueEntry, secret: string): Promise<string | null> {
  if (e.check.startsWith("builtin:")) return builtin(d, e.check.slice(8), secret);
  const r = await (d.run ?? defaultRunner)(e.check, envFor(d, e, secret), d.timeoutMs ?? 30_000);
  if (r.code === 0) return null;
  const line = scrub(r.stderr, secret).split("\n").find((l) => l.trim()) ?? "";
  return `exit ${r.code ?? "timeout"}${line ? `: ${line.slice(0, 200)}` : ""}`;
}

/** The expiry as ISO time or null: `none` and `index` read nothing here; `{probe}` runs its command. */
export async function probeExpiry(d: CredDeps, e: CatalogueEntry, secret: string, fallback: string | null): Promise<string | null> {
  if (e.expiry === "none") return null;
  if (e.expiry === "index") return fallback;
  const r = await (d.run ?? defaultRunner)(e.expiry.probe, envFor(d, e, secret), d.timeoutMs ?? 30_000);
  const out = r.stdout.trim();
  if (r.code !== 0 || !out || out === "none") return null;
  return Number.isNaN(Date.parse(out)) ? fallback : new Date(out).toISOString();
}

/** Spec 030 AC-4: check one credential and update its index entry. */
export async function checkCredential(d: CredDeps, name: string): Promise<CheckOutcome> {
  const e = d.catalogue[name];
  if (!e) throw new Error(`unknown credential ${name}`);
  const index = await d.store.readIndex();
  if (!index[name]) return { name, status: "missing", expires_at: null };
  let secret = "";
  let status: CheckOutcome["status"];
  let expires = index[name].expires_at;
  try {
    secret = await d.store.readSecret(name);
    const reason = await runCheck(d, e, secret);
    status = reason === null ? "ok" : `failed: ${reason}`;
    expires = await probeExpiry(d, e, secret, index[name].expires_at);
  } catch (err) {
    status = `failed: ${scrub((err as Error).message, secret)}`;
  }
  await d.store.updateIndex(name, (cur) => ({ ...(cur as IndexEntry), expires_at: expires, last_checked_at: d.now().toISOString(), last_check: status }));
  return { name, status, expires_at: expires };
}

export async function checkAll(d: CredDeps): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const name of Object.keys(d.catalogue)) out.push(await checkCredential(d, name));
  return out;
}

const DAY = 86_400_000;
export const daysLeft = (expires: string | null, now: Date) => (expires === null ? null : Math.floor((Date.parse(expires) - now.getTime()) / DAY));

/** Spec 030 AC-5: credentials whose expiry is near or whose last check failed, not yet emitted today. */
export async function dueExpiryEvents(d: CredDeps, warnDays: number, emit: (name: string, payload: unknown) => Promise<void> | void): Promise<string[]> {
  const index = await d.store.readIndex();
  const day = d.now().toISOString().slice(0, 10);
  let emitted: Record<string, string> = {};
  try {
    emitted = JSON.parse(await readFile(d.paths.credentialExpiryEmitted, "utf8"));
  } catch {
    /* none yet */
  }
  const names: string[] = [];
  for (const [name, i] of Object.entries(index)) {
    const e = d.catalogue[name];
    if (!e || e.expiry === "none") continue;
    const left = daysLeft(i.expires_at, d.now());
    const near = left !== null && left <= warnDays;
    const failed = i.last_check !== null && i.last_check.startsWith("failed");
    if (!(near || failed) || emitted[name] === day) continue;
    await emit("credential_expiry", { name, expires_at: i.expires_at, last_check: i.last_check });
    emitted[name] = day;
    names.push(name);
  }
  if (names.length) {
    await mkdir(dirname(d.paths.credentialExpiryEmitted), { recursive: true });
    await writeFile(d.paths.credentialExpiryEmitted, JSON.stringify(emitted));
  }
  return names;
}
