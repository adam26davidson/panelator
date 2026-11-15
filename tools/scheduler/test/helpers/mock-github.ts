import { createPublicKey, verify } from "node:crypto";

export interface Call { method: string; url: string; body: unknown; headers?: Record<string, string> }
export type Route = { method: string; path: RegExp; reply: (m: RegExpExecArray, body: unknown, url: URL, headers?: Record<string, string>) => { status?: number; body: unknown; headers?: Record<string, string> } };

/** A fetch that answers from a route table and records every call. Unmatched routes return 404 with the url and are listed in `unmatched`. */
export function mockGitHub(routes: Route[]): { fetch: typeof fetch; calls: Call[]; routes: Route[]; unmatched: string[] } {
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: url.pathname + url.search, body, headers });
    for (const r of routes) {
      const m = r.path.exec(url.pathname);
      if (m && r.method === method) {
        const res = r.reply(m, body, url, headers);
        const response = new Response(res.status === 204 ? null : JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json", ...(res.headers ?? {}) } });
        Object.defineProperty(response, "url", { value: url.href });
        return response;
      }
    }
    unmatched.push(`${method} ${url.pathname}`);
    const res = new Response(JSON.stringify({ message: `mock: no route for ${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { fetch: fetchFn, calls, routes, unmatched };
}

export const tokenRoute: Route = {
  method: "POST", path: /^\/app\/installations\/(\d+)\/access_tokens$/,
  reply: () => ({ status: 201, body: { token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "selected" } }),
};
export const appRoute: Route = { method: "GET", path: /^\/app$/, reply: () => ({ body: { id: 1, slug: "panelator-pipeline", name: "panelator-pipeline" } }) };

export function pageLink(url: URL, page: number, last: number): Record<string, string> {
  if (page >= last) return {};
  const next = new URL(url);
  next.searchParams.set("page", String(page + 1));
  return { link: `<${next}>; rel="next"` };
}

/** `GET /app` that answers only to a Bearer JWT signed (RS256) by the private half of `publicKeyPem` whose `iss` is `appId`; anything else is 401 (spec 069 section 3). */
export function appRouteFor(publicKeyPem: string, appId: number, slug: string, replyId: number = appId): Route {
  const pub = createPublicKey(publicKeyPem);
  return {
    method: "GET", path: /^\/app$/,
    reply: (_m, _b, _u, headers) => {
      const jwt = /^bearer (.+)$/i.exec(headers?.authorization ?? "")?.[1];
      const [h, p, sig] = jwt?.split(".") ?? [];
      try {
        const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { iss?: unknown };
        const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, Buffer.from(sig, "base64url")) && String(payload.iss) === String(appId);
        if (ok) return { body: { id: replyId, slug } };
      } catch { /* falls through to 401 */ }
      return { status: 401, body: { message: "A JSON web token could not be decoded" } };
    },
  };
}
