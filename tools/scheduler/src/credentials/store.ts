import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";

export type SetBy = "maintainer" | "import";
export interface IndexEntry {
  name: string;
  created_at: string;
  set_by: SetBy;
  expires_at: string | null;
  last_checked_at: string | null;
  last_check: string | null;
  /** Spec 068 AC-2: the CLI renews the access token itself; `expires_at` is then the login registration's end. */
  renewable?: boolean;
  /** Spec 068 AC-2: the `expires_at` a heads-up was last sent for. */
  heads_up_for?: string;
}
export type CredentialIndex = Record<string, IndexEntry>;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The encrypted credential store of spec 030 AC-1: `<dir>/<name>.cred` blobs through `systemd-creds` and `<dir>/index.json`. The only decryption is `readSecret`; the only `systemd-creds` spawn is here. */
export class CredentialStore {
  readonly dir: string;
  private readonly systemdCreds: string;
  private readonly now: () => Date;
  constructor(opts: { dir: string; systemdCreds?: string; now?: () => Date }) {
    this.dir = opts.dir;
    this.systemdCreds = opts.systemdCreds ?? "systemd-creds";
    this.now = opts.now ?? (() => new Date());
  }
  private get indexPath() { return join(this.dir, "index.json"); }
  private blob(name: string) {
    if (!NAME.test(name)) throw new Error(`invalid credential name ${JSON.stringify(name)}`);
    return join(this.dir, `${name}.cred`);
  }
  private run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.systemdCreds, args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
      child.on("error", (e) => reject(new Error(`systemd-creds failed to start: ${e.message}`)));
      child.stdin.on("error", () => {});
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`systemd-creds exited ${code}: ${err.trim()}`))));
      child.stdin.end(input ?? "");
    });
  }
  async readIndex(): Promise<CredentialIndex> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as CredentialIndex;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
  private async saveIndex(index: CredentialIndex): Promise<void> {
    const tmp = this.indexPath + ".tmp";
    await writeFile(tmp, JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.indexPath);
  }
  async writeSecret(name: string, text: string, setBy: SetBy): Promise<void> {
    const blob = this.blob(name);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.run(["--user", "encrypt", `--name=${name}`, "-", blob], text);
    const index = await this.readIndex();
    index[name] = { name, created_at: this.now().toISOString(), set_by: setBy, expires_at: null, last_checked_at: null, last_check: null };
    await this.saveIndex(index);
  }
  /** Spec 099 AC-13: the expiry a renewal's probe read; a name with no entry is left alone. */
  async writeExpiry(name: string, expires_at: string | null, renewable?: boolean): Promise<void> {
    const index = await this.readIndex();
    if (!index[name]) return;
    const { renewable: _old, ...rest } = index[name];
    index[name] = { ...rest, expires_at, ...(renewable === undefined ? (_old === undefined ? {} : { renewable: _old }) : renewable ? { renewable } : {}) };
    await this.saveIndex(index);
  }
  /** Spec 068 AC-2: the time a renewable credential's heads-up was sent for. */
  async writeHeadsUp(name: string, expires_at: string): Promise<void> {
    const index = await this.readIndex();
    if (!index[name]) return;
    index[name] = { ...index[name], heads_up_for: expires_at };
    await this.saveIndex(index);
  }
  async readSecret(name: string): Promise<string> {
    try {
      return await this.run(["--user", "decrypt", `--name=${name}`, this.blob(name), "-"]);
    } catch (e) {
      throw new Error(`cannot read credential ${name}: ${(e as Error).message}; run panelator-scheduler cred set ${name}`);
    }
  }
  async removeSecret(name: string): Promise<void> {
    const blob = this.blob(name);
    await rm(blob, { force: true });
    const index = await this.readIndex();
    delete index[name];
    await this.saveIndex(index);
  }
  /** The check fields of an entry; check.ts's `runCheck` is the only caller. A name with no entry is left alone. */
  async writeCheck(name: string, patch: Pick<IndexEntry, "last_checked_at" | "last_check">): Promise<void> {
    const index = await this.readIndex();
    if (!index[name]) return;
    index[name] = { ...index[name], ...patch };
    await this.saveIndex(index);
  }
}

export function storeFromConfig(cfg: Pick<Config, "credentials">, env: NodeJS.ProcessEnv = process.env): CredentialStore {
  return new CredentialStore({ dir: cfg.credentials.dir, systemdCreds: env.PANELATOR_SYSTEMD_CREDS || undefined });
}

/** Spec 069 AC-9: the App key comes from the store once `github-app-key` is set, else from `app.private_key_path`; the source is reported for spec 072 AC-2. */
export async function appPrivateKeySource(cfg: Pick<Config, "app">, store: CredentialStore): Promise<{ key: string; source: "store" | "file" }> {
  const index = await store.readIndex();
  if (index["github-app-key"]) {
    try {
      return { key: await store.readSecret("github-app-key"), source: "store" };
    } catch (e) {
      throw new Error(`cannot read the stored GitHub App key: ${(e as Error).message}`);
    }
  }
  try {
    return { key: readFileSync(cfg.app.private_key_path, "utf8"), source: "file" };
  } catch (e) {
    throw new Error(`cannot read the GitHub App private key at ${cfg.app.private_key_path}: ${(e as Error).message}`);
  }
}

export async function appPrivateKey(cfg: Pick<Config, "app">, store: CredentialStore): Promise<string> {
  return (await appPrivateKeySource(cfg, store)).key;
}
