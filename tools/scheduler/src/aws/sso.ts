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

export type SsoExpiry = { expires_at: string; renewable: boolean } | { none: true } | { error: string };

/**
 * Spec 068 AC-2: the time a login is needed by, from the CLI's cached token file. Only `expiresAt`,
 * `registrationExpiresAt` and whether a `refreshToken` key is present are taken from the parsed file, which is not
 * kept, passed on or logged. A session the CLI renews itself (an `sso_session` profile whose cache holds a refresh
 * token and a registration time) answers with the registration's end; any other answers with `expiresAt`.
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
  let registrationExpiresAt: unknown;
  let hasRefresh = false;
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, `${createHash("sha1").update(key).digest("hex")}.json`), "utf8")) as Record<string, unknown>;
    expiresAt = parsed.expiresAt;
    registrationExpiresAt = parsed.registrationExpiresAt;
    hasRefresh = Object.hasOwn(parsed, "refreshToken");
  } catch {
    return { error: "no cached SSO token found (run aws sso login)" };
  }
  const valid = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
  if (stanza.sso_session !== undefined && hasRefresh && valid(registrationExpiresAt)) return { expires_at: registrationExpiresAt, renewable: true };
  if (!valid(expiresAt)) return { error: "no expiresAt in the cached token" };
  return { expires_at: expiresAt, renewable: false };
}

/** The words `aws-check` and `aws sso-expiry` print for a result. */
export function ssoExpiryText(r: SsoExpiry): string {
  return "expires_at" in r ? r.expires_at : "none" in r ? "none" : r.error;
}
