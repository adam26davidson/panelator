import { App, Octokit } from "octokit";
import type { Config } from "../config.ts";
import type { StatePaths } from "../state/paths.ts";
import { writeToken, type TokenFile } from "../state/token.ts";

export interface AppClient {
  octokit: Octokit;
  installationToken(): Promise<TokenFile>;
  refreshTokenFile(paths: StatePaths): Promise<TokenFile>;
  startTokenRefresh(paths: StatePaths, intervalMs?: number, retryMs?: number): () => void;
  botLogin(): Promise<string>;
}

export const TOKEN_REFRESH_MS = 50 * 60_000;
export const TOKEN_RETRY_MS = 60_000;
export const TOKEN_RETRY_ATTEMPTS = 3;

export function createAppClient(cfg: Config["app"], privateKey: string, fetchFn: typeof fetch = fetch): AppClient {
  const app = new App({ appId: cfg.id, privateKey, Octokit: Octokit.defaults({ request: { fetch: fetchFn } }) });
  let installation: Octokit | null = null;

  const client: AppClient = {
    get octokit() {
      if (!installation) throw new Error("call installationToken() before using the client");
      return installation;
    },
    async installationToken() {
      // Installation-authenticated client for all repository calls; octokit renews its own token internally.
      installation ??= await app.getInstallationOctokit(cfg.installation_id);
      // `refresh: true` bypasses octokit's token cache so every call here mints a fresh one for token.json.
      const a = (await app.octokit.auth({ type: "installation", installationId: cfg.installation_id, refresh: true })) as { token: string; expiresAt: string };
      return { token: a.token, expires_at: a.expiresAt };
    },
    async refreshTokenFile(paths) {
      const t = await client.installationToken();
      await writeToken(paths, t);
      return t;
    },
    startTokenRefresh(paths, intervalMs = TOKEN_REFRESH_MS, retryMs = TOKEN_RETRY_MS) {
      let stopped = false;
      let inFlight = false;
      let retry: ReturnType<typeof setTimeout> | null = null;
      const clearRetry = () => {
        if (retry) clearTimeout(retry);
        retry = null;
      };
      // A failed mint is retried up to TOKEN_RETRY_ATTEMPTS per tick so token.json never sits expired until the next tick.
      const attempt = (n: number) => {
        inFlight = true;
        client
          .refreshTokenFile(paths)
          .catch((e) => {
            console.error(`token refresh failed (attempt ${n}/${TOKEN_RETRY_ATTEMPTS}): ${(e as Error).message}`);
            if (stopped || n >= TOKEN_RETRY_ATTEMPTS) return;
            retry = setTimeout(() => {
              retry = null;
              attempt(n + 1);
            }, retryMs);
            retry.unref();
          })
          .finally(() => {
            inFlight = false;
          });
      };
      const timer = setInterval(() => {
        // Overlapping refreshes would race on token.json's temp file; the running one already mints a fresh token.
        if (inFlight) return;
        clearRetry();
        attempt(1);
      }, intervalMs);
      timer.unref();
      return () => {
        stopped = true;
        clearInterval(timer);
        clearRetry();
      };
    },
    async botLogin() {
      const { data } = await app.octokit.request("GET /app");
      return `${(data as { slug: string }).slug}[bot]`;
    },
  };
  return client;
}
