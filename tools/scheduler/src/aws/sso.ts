import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The text of `[profile <name>]` in the AWS config as key/value pairs; null when the stanza is absent. */
export function profileStanza(config: string, profile: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let inside = false;
  let found = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      inside = head[1].trim() === (profile === "default" ? "default" : `profile ${profile}`);
      if (inside) found = true;
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (inside && kv) out[kv[1]] = kv[2].trim();
  }
  return found ? out : null;
}

export type SsoExpiry = { expires_at: string } | { none: true } | { error: string };

/**
 * Spec 068 AC-2: the profile's SSO session expiry from the CLI's cached token. Only `expiresAt` is taken from the
 * parsed file, which is not kept, passed on or logged.
 */
export function ssoExpiry(profile: string, env: NodeJS.ProcessEnv = process.env): SsoExpiry {
  const home = env.HOME || homedir();
  const configPath = env.AWS_CONFIG_FILE || join(home, ".aws", "config");
  const cacheDir = env.AWS_SSO_CACHE_DIR || join(home, ".aws", "sso", "cache");
  let stanza: Record<string, string> | null = null;
  try {
    stanza = profileStanza(readFileSync(configPath, "utf8"), profile);
  } catch {
    /* unreadable: the same error as no stanza */
  }
  if (!stanza) return { error: `no profile ${profile} in ${configPath}` };
  const key = stanza.sso_session ?? stanza.sso_start_url;
  if (!key) return { none: true };
  let expiresAt: unknown;
  try {
    expiresAt = (JSON.parse(readFileSync(join(cacheDir, `${createHash("sha1").update(key).digest("hex")}.json`), "utf8")) as { expiresAt?: unknown }).expiresAt;
  } catch {
    return { error: "no cached SSO token found (run aws sso login)" };
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return { error: "no expiresAt in the cached token" };
  return { expires_at: expiresAt };
}

/** The words `aws-check` and `aws sso-expiry` print for a result. */
export function ssoExpiryText(r: SsoExpiry): string {
  return "expires_at" in r ? r.expires_at : "none" in r ? "none" : r.error;
}
