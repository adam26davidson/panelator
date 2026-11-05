import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface IndexEntry {
  created_at: string;
  set_by: "maintainer" | "import";
  expires_at: string | null;
  last_checked_at: string | null;
  last_check: string | null;
}
export type Index = Record<string, IndexEntry>;

/** Spec 030 AC-1: `<name>.cred` blobs sealed by `systemd-creds --user`, plus an index that holds no secret. */
export class CredentialStore {
  readonly dir: string;
  private readonly bin: string;
  constructor(dir: string, bin = process.env.PANELATOR_SYSTEMD_CREDS || "systemd-creds") {
    this.dir = dir;
    this.bin = bin;
  }

  private blob(name: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid credential name: ${name}`);
    return join(this.dir, `${name}.cred`);
  }

  private run(op: "encrypt" | "decrypt", name: string, input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, ["--user", op, `--name=${name}`, "-", "-"], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 30_000 }, (err, stdout) => {
        // the message never carries stdout or stdin, which may hold the secret
        if (err) reject(new Error(`systemd-creds ${op} failed for ${name}`));
        else resolve(stdout);
      });
      child.stdin?.end(input);
    });
  }

  /** Decrypted into memory only, for one exec or one check. */
  async readSecret(name: string): Promise<string> {
    let blob: string;
    try {
      blob = await readFile(this.blob(name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`credential ${name} is not set`);
      throw e;
    }
    return this.run("decrypt", name, blob);
  }

  async has(name: string): Promise<boolean> {
    return (await this.readIndex())[name] !== undefined;
  }

  async writeSecret(name: string, secret: string, setBy: "maintainer" | "import", now: Date = new Date()): Promise<void> {
    const sealed = await this.run("encrypt", name, secret);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const path = this.blob(name);
    await writeFile(path + ".tmp", sealed, { mode: 0o600 });
    await rename(path + ".tmp", path);
    await this.updateIndex(name, () => ({ created_at: now.toISOString(), set_by: setBy, expires_at: null, last_checked_at: null, last_check: null }));
  }

  async removeSecret(name: string): Promise<void> {
    await rm(this.blob(name), { force: true });
    const index = await this.readIndex();
    delete index[name];
    await this.writeIndex(index);
  }

  async readIndex(): Promise<Index> {
    try {
      return JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")) as Index;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeIndex(index: Index): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, "index.json");
    await writeFile(path + ".tmp", JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
    await rename(path + ".tmp", path);
  }

  async updateIndex(name: string, f: (e: IndexEntry | undefined) => IndexEntry): Promise<IndexEntry> {
    const index = await this.readIndex();
    index[name] = f(index[name]);
    await this.writeIndex(index);
    return index[name];
  }
}
