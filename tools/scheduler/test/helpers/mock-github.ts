export interface Call { method: string; url: string; body: unknown }
export type Route = { method: string; path: RegExp; reply: (m: RegExpExecArray, body: unknown, url: URL) => { status?: number; body: unknown; headers?: Record<string, string> } };

/** A fetch that answers from a route table and records every call. Unmatched routes return 404 with the url. */
export function mockGitHub(routes: Route[]): { fetch: typeof fetch; calls: Call[]; routes: Route[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: url.pathname + url.search, body });
    for (const r of routes) {
      const m = r.path.exec(url.pathname);
      if (m && r.method === method) {
        const res = r.reply(m, body, url);
        const response = new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json", ...(res.headers ?? {}) } });
        Object.defineProperty(response, "url", { value: url.href });
        return response;
      }
    }
    const res = new Response(JSON.stringify({ message: `mock: no route for ${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { fetch: fetchFn, calls, routes };
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
