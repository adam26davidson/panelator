import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { validate } from "../schema/validate.ts";

/** Spec 030 AC-1: one encrypted blob per secret plus an index that holds no secret. */
export interface IndexEntry {
  name: string;
  created_at: string;
  set_by: "maintainer" | "import";
  expires_at: string | null;
  last_checked_at: string | null;
  last_check: string | null;
}

export interface StoreOptions {
  dir: string;
  /** the `systemd-creds` command path; injectable for the fake */
  systemdCreds?: string;
  now?: () => Date;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** Runs `systemd-creds` with the given stdin; the one place it is spawned. Errors never carry its output, which could hold the secret. */
function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", (e) => reject(new Error(`cannot run ${command}: ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(`${command} ${args[1] ?? ""} failed (exit ${code})`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export class CredentialStore {
  readonly dir: string;
  private command: string;
  private now: () => Date;

  constructor(opts: StoreOptions) {
    this.dir = opts.dir;
    this.command = opts.systemdCreds ?? "systemd-creds";
    this.now = opts.now ?? (() => new Date());
  }

  private blob(name: string): string {
    if (!NAME.test(name)) throw new Error(`invalid credential name: ${name}`);
    return join(this.dir, `${name}.cred`);
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  async readIndex(): Promise<IndexEntry[]> {
    let text: string;
    try {
      text = await readFile(this.indexPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const data = JSON.parse(text) as unknown;
    const v = validate("credential-index", data);
    if (!v.ok) throw new Error(`credential index is invalid: ${v.errors.join("; ")}`);
    return data as IndexEntry[];
  }

  private async writeIndex(entries: IndexEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.indexPath);
  }

  async has(name: string): Promise<boolean> {
    return (await this.readIndex()).some((e) => e.name === name);
  }

  async writeSecret(name: string, text: string, setBy: IndexEntry["set_by"]): Promise<IndexEntry> {
    const file = this.blob(name);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await run(this.command, ["--user", "encrypt", `--name=${name}`, "-", file], text);
    const entry: IndexEntry = { name, created_at: this.now().toISOString(), set_by: setBy, expires_at: null, last_checked_at: null, last_check: null };
    await this.writeIndex([...(await this.readIndex()).filter((e) => e.name !== name), entry]);
    return entry;
  }

  /** The only decryption: the plaintext goes to memory and nowhere else. */
  async readSecret(name: string): Promise<string> {
    const file = this.blob(name);
    return run(this.command, ["--user", "decrypt", file, "-"]);
  }

  async removeSecret(name: string): Promise<boolean> {
    const file = this.blob(name);
    const entries = await this.readIndex();
    if (!entries.some((e) => e.name === name)) return false;
    await rm(file, { force: true });
    await this.writeIndex(entries.filter((e) => e.name !== name));
    return true;
  }

  /** Used only by `runCheck`, the one writer of the index's check fields. */
  async updateCheck(name: string, last_checked_at: string, last_check: string | null): Promise<void> {
    const entries = await this.readIndex();
    const e = entries.find((x) => x.name === name);
    if (!e) return;
    e.last_checked_at = last_checked_at;
    e.last_check = last_check;
    await this.writeIndex(entries);
  }
}

export function storeFor(cfg: Config, systemdCreds?: string): CredentialStore {
  return new CredentialStore({ dir: cfg.credentials.dir, systemdCreds });
}

export const APP_KEY_CREDENTIAL = "github-app-key";

/** Spec 030 AC-3's rule: the App key is the stored one once `github-app-key` is set, else the file at `app.private_key_path`. */
export async function appPrivateKey(cfg: Config, store: CredentialStore, readFile_: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<{ source: "store" | "path"; key: string }> {
  if (await store.has(APP_KEY_CREDENTIAL)) {
    try {
      return { source: "store", key: await store.readSecret(APP_KEY_CREDENTIAL) };
    } catch (e) {
      throw new Error(`cannot read the stored credential ${APP_KEY_CREDENTIAL} (${(e as Error).message}); run \`panelator-scheduler cred set ${APP_KEY_CREDENTIAL}\` again`);
    }
  }
  try {
    return { source: "path", key: await readFile_(cfg.app.private_key_path) };
  } catch (e) {
    throw new Error(`cannot read the GitHub App private key at ${cfg.app.private_key_path}: ${(e as Error).message}`);
  }
}
