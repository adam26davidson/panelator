import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ActionLog } from "../actions/log.ts";
import { checkAll, checkCredential, daysLeft, type CredDeps } from "./check.ts";

/** Spec 030 AC-4: every command is logged as the maintainer with the credential's name only. */
async function logged<T>(log: ActionLog, kind: string, name: string | undefined, f: () => Promise<T>): Promise<T> {
  const row = await log.writePending({ agent: "maintainer", run_id: "command", kind, args: name ? { name } : {}, why: `Maintainer command line ${kind.replace("_", " ")}`, undo: null });
  try {
    const r = await f();
    await log.settle(row.id, "applied");
    return r;
  } catch (e) {
    await log.settle(row.id, "failed", (e as Error).message);
    throw e;
  }
}

const need = (d: CredDeps, name: string) => {
  if (!d.catalogue[name]) throw new Error(`${name} is not in agents/credentials.yaml`);
};

export async function credSet(d: CredDeps, log: ActionLog, name: string, secret: string, setBy: "maintainer" | "import" = "maintainer"): Promise<string> {
  need(d, name);
  const value = secret.replace(/\r?\n$/, "");
  if (!value) throw new Error("the secret on stdin is empty");
  return logged(log, "cred_set", name, async () => {
    await d.store.writeSecret(name, value, setBy, d.now());
    const r = await checkCredential(d, name);
    return `${name}: stored, check ${r.status}`;
  });
}

export async function credList(d: CredDeps): Promise<string> {
  const index = await d.store.readIndex();
  return Object.values(d.catalogue)
    .map((e) => {
      const i = index[e.name];
      if (!i) return `${e.name}\tmissing\t-\t-`;
      const left = daysLeft(i.expires_at, d.now());
      return `${e.name}\tset\texpires ${i.expires_at ?? "never"}${left === null ? "" : ` (${left}d)`}\tcheck ${i.last_check ?? "never run"}`;
    })
    .join("\n");
}

export async function credCheck(d: CredDeps, log: ActionLog, name?: string): Promise<{ text: string; ok: boolean }> {
  if (name) need(d, name);
  const results = await logged(log, "cred_check", name, () => (name ? Promise.all([checkCredential(d, name)]) : checkAll(d)));
  return { text: results.map((r) => `${r.name}: ${r.status}`).join("\n"), ok: results.every((r) => r.status === "ok") };
}

export async function credImport(d: CredDeps, log: ActionLog, files: { app_key: string; telegram: string }): Promise<string> {
  const lines: string[] = [];
  for (const [name, path] of [["github-app-key", files.app_key], ["telegram-bot", files.telegram]] as const) {
    if (!existsSync(path)) {
      lines.push(`${name}: ${path} not found, skipped`);
      continue;
    }
    lines.push(await logged(log, "cred_import", name, async () => {
      await d.store.writeSecret(name, (await readFile(path, "utf8")).replace(/\r?\n$/, ""), "import", d.now());
      const r = await checkCredential(d, name);
      return `${name}: imported, check ${r.status}`;
    }));
  }
  lines.push(`Delete these by hand once the checks pass: ${files.app_key} ${files.telegram}`);
  return lines.join("\n");
}

export async function credRemove(d: CredDeps, log: ActionLog, name: string): Promise<string> {
  need(d, name);
  await logged(log, "cred_remove", name, () => d.store.removeSecret(name));
  return `${name}: removed`;
}

/** Spec 030 AC-3: run the real command with the secret in the child's environment only; return its exit status. */
export async function credExec(d: CredDeps, name: string, argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  need(d, name);
  const e = d.catalogue[name];
  if (e.wrapper === "none") throw new Error(`${name} has no wrapper`);
  if (e.provider === "aws") throw new Error("aws credentials run through src/aws/cli.ts");
  const secret = await d.store.readSecret(name);
  const shimDir = env.PANELATOR_SHIM_DIR;
  const path = (env.PATH ?? "").split(delimiter).filter((p) => p && (!shimDir || join(p) !== join(shimDir))).join(delimiter);
  const child = spawn(e.wrapper.command, [...argv], { env: { ...env, PATH: path, [e.wrapper.env]: secret }, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
