import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPlainFiles } from "../src/credentials/plain-files.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import type { Notification } from "../src/notify/types.ts";
import { statePaths } from "../src/state/paths.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-systemd-creds");
const DAY = 24 * 3_600_000;

async function setup(fromStore: string[] = ["github-app-key", "telegram-bot"]) {
  const root = mkdtempSync(join(tmpdir(), "plain-"));
  const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: fake });
  await store.writeSecret("github-app-key", "k", "import");
  await store.writeSecret("telegram-bot", "{}", "import");
  const paths = { "github-app-key": join(root, "app.pem"), "telegram-bot": join(root, "telegram.json") };
  writeFileSync(paths["github-app-key"], "x");
  writeFileSync(paths["telegram-bot"], "y");
  const sp = statePaths(join(root, "state"));
  mkdirSync(join(root, "state"), { recursive: true });
  let t = Date.parse("2026-11-18T00:00:00Z");
  const sent: string[] = [];
  const notes: Notification[] = [];
  const logs: Record<string, unknown>[] = [];
  let fail = false;
  const mk = (telegram: boolean = true) => ({
    store, paths, fromStore: new Set(fromStore), statePath: sp.plainFilesReminder,
    telegram: telegram ? { sendReply: async (text: string) => { if (fail) throw new Error("down"); sent.push(text); return 1; } } : null,
    notifier: { notify: async (n: Notification) => { notes.push(n); } },
    now: () => new Date(t), log: (r: Record<string, unknown>) => logs.push(r),
  });
  return { root, store, paths, sp, sent, notes, logs, mk, advance: (ms: number) => (t += ms), setFail: (f: boolean) => (fail = f) };
}

describe("checkPlainFiles (spec 072 AC-3 to AC-6)", () => {
  it("sends once naming both, then not within the week or after a restart, then weekly", async () => {
    const t = await setup();
    await checkPlainFiles(t.mk());
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain(`- ${t.paths["github-app-key"]} (github-app-key)\n- ${t.paths["telegram-bot"]} (telegram-bot)\nDelete them by hand; this reminder repeats weekly while one remains.`);
    expect(t.notes).toEqual([{ issue: 0, gate: "credential", label: "plain-files", text: t.sent[0] }]);
    expect(JSON.parse(readFileSync(t.sp.plainFilesReminder, "utf8")).files).toHaveLength(2);
    t.advance(3_600_000);
    await checkPlainFiles(t.mk());
    await checkPlainFiles(t.mk());
    expect(t.sent).toHaveLength(1);
    t.advance(7 * DAY);
    await checkPlainFiles(t.mk());
    expect(t.sent).toHaveLength(2);
    expect(existsSync(t.sp.findingsQueue)).toBe(false);
  });
  it("names only the remaining file, and removes the state once both are gone", async () => {
    const t = await setup();
    await checkPlainFiles(t.mk());
    const { rmSync } = await import("node:fs");
    rmSync(t.paths["github-app-key"]);
    t.advance(8 * DAY);
    await checkPlainFiles(t.mk());
    expect(t.sent[1]).toContain("telegram.json");
    expect(t.sent[1]).not.toContain("app.pem");
    rmSync(t.paths["telegram-bot"]);
    t.advance(DAY);
    await checkPlainFiles(t.mk());
    expect(t.sent).toHaveLength(2);
    expect(existsSync(t.sp.plainFilesReminder)).toBe(false);
  });
  it("does not name a credential the process read from its file, an entry removed from the index, or a directory", async () => {
    const t = await setup(["github-app-key"]);
    await t.store.removeSecret("github-app-key");
    await checkPlainFiles(t.mk());
    expect(t.sent).toEqual([]);
    const d = await setup(["telegram-bot"]);
    const { rmSync } = await import("node:fs");
    rmSync(d.paths["telegram-bot"]);
    mkdirSync(d.paths["telegram-bot"]);
    await checkPlainFiles(d.mk());
    expect(d.sent).toEqual([]);
  });
  it("leaves no state and no notification when the send fails, and the next check sends", async () => {
    const t = await setup();
    t.setFail(true);
    await checkPlainFiles(t.mk());
    expect(t.notes).toEqual([]);
    expect(existsSync(t.sp.plainFilesReminder)).toBe(false);
    expect(t.logs).toEqual([{ kind: "plain-files-reminder-failed", error: "down" }]);
    t.setFail(false);
    await checkPlainFiles(t.mk());
    expect(t.sent).toHaveLength(1);
  });
  it("notifies and records state without Telegram", async () => {
    const t = await setup();
    await checkPlainFiles(t.mk(false));
    expect(t.notes).toHaveLength(1);
    expect(existsSync(t.sp.plainFilesReminder)).toBe(true);
  });
  it("throws when the index cannot be read", async () => {
    const t = await setup();
    writeFileSync(join(t.store.dir, "index.json"), "{");
    await expect(checkPlainFiles(t.mk())).rejects.toThrow();
  });
});
