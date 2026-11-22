import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { type Deps, handle } from "../api/handlers.ts";
import { MemoryTable } from "../api/table.ts";
import { App } from "../src/app/App.tsx";
import { makeApi } from "../src/shared/api/client.ts";
import type { ChangeEntry, ConsoleState } from "../src/shared/api/types.ts";
import { NOW, snapshot } from "./fixtures.ts";

export interface Net {
  snapshot: ConsoleState;
  ageS: number;
  failing: boolean;
  unauthorized: boolean;
  hang: boolean;
  posts: { kind: string; args: Record<string, unknown> }[];
  loggedOut: boolean;
  /** The ids the real handler gave the posted changes, in order. */
  ids: number[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Records the outcome of change `id` in the snapshot, as the scheduler's push would. */
  settle: (c: Omit<ChangeEntry, "at" | "kind" | "args"> & Partial<ChangeEntry>) => void;
}

export function makeNet(over: Partial<Pick<Net, "snapshot" | "ageS" | "failing" | "unauthorized" | "hang">> = {}): Net {
  const net: Net = {
    snapshot,
    ageS: 18,
    failing: false,
    unauthorized: false,
    hang: false,
    posts: [],
    loggedOut: false,
    ...over,
    settle(c) {
      const sent = net.posts[c.id - 1];
      c = { ...c, id: net.ids[c.id - 1] ?? c.id };
      net.snapshot = {
        ...net.snapshot,
        changes: [
          ...net.snapshot.changes,
          { kind: sent?.kind ?? "", args: sent?.args ?? {}, at: "2026-11-22T10:45:00Z", ...c },
        ],
      };
    },
    ids: [],
    async fetch(url, init) {
      if (url === "/state" && net.hang) return new Promise<Response>(() => undefined);
      if (url === "/state" && net.failing) return new Response("down", { status: 502 });
      // Every other request is answered by the real handlers of console/api/ over an in-memory table.
      const api = await real(net);
      const u = new URL(url, "https://c.example");
      const headers: Record<string, string> = { host: "c.example" };
      if (init?.method === "POST") headers.origin = "https://c.example";
      if (api.cookie && !net.unauthorized && !net.loggedOut) headers.cookie = `session=${api.cookie}`;
      if (url === "/state") await api.table.putState(net.snapshot, NOW - net.ageS * 1000);
      const res = await handle(api.deps, {
        method: init?.method ?? "GET",
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url === "/changes" && init?.method === "POST" && res.status === 200) {
        net.posts.push(JSON.parse(String(init.body)));
        net.ids.push((JSON.parse(res.body) as { id: number }).id);
      }
      if (url === "/auth/logout") net.loggedOut = true;
      return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
    },
  };
  return net;
}

const reals = new WeakMap<Net, Promise<{ deps: Deps; table: MemoryTable; cookie?: string }>>();
function real(net: Net) {
  let p = reals.get(net);
  if (!p) {
    p = (async () => {
      const table = new MemoryTable();
      const deps: Deps = {
        table,
        keyHash: "",
        maintainer: "maintainer",
        clientId: "cid",
        clientSecret: async () => "shh",
        fetch: async (u) =>
          new Response(
            JSON.stringify(String(u).includes("access_token") ? { access_token: "t" } : { login: "maintainer" }),
          ),
        now: () => NOW,
        sleep: async () => undefined,
      };
      const h = { host: "c.example" };
      const lg = await handle(deps, { method: "GET", path: "/auth/login", query: {}, headers: h, body: "" });
      const state = /oauth_state=([0-9a-f]+)/.exec(lg.headers["set-cookie"])?.[1] ?? "";
      const cb = await handle(deps, {
        method: "GET",
        path: "/auth/callback",
        query: { code: "c", state },
        headers: { ...h, cookie: `oauth_state=${state}` },
        body: "",
      });
      return { deps, table, cookie: /session=([0-9a-f]+)/.exec(cb.headers["set-cookie"] ?? "")?.[1] };
    })();
    reals.set(net, p);
  }
  return p;
}

export function mount(path: string, net: Net) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} api={makeApi(net.fetch)} nowFn={() => NOW} pollMs={40} />);
}
