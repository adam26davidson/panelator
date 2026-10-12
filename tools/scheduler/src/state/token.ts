import { readFile, rename, writeFile } from "node:fs/promises";
import type { StatePaths } from "./paths.ts";

export interface TokenFile {
  token: string;
  expires_at: string;
}

export async function readToken(p: StatePaths): Promise<TokenFile | null> {
  try {
    const t = JSON.parse(await readFile(p.token, "utf8")) as TokenFile;
    return typeof t.token === "string" && typeof t.expires_at === "string" ? t : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeToken(p: StatePaths, t: TokenFile): Promise<void> {
  const tmp = p.token + ".tmp";
  await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
  await rename(tmp, p.token);
}
