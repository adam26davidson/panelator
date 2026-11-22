import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
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
      net.snapshot = {
        ...net.snapshot,
        changes: [
          ...net.snapshot.changes,
          { kind: sent?.kind ?? "", args: sent?.args ?? {}, at: "2026-11-22T10:45:00Z", ...c },
        ],
      };
    },
    async fetch(url, init) {
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url === "/state") {
        if (net.hang) return new Promise<Response>(() => undefined);
        if (net.unauthorized || net.loggedOut) return new Response("sign in", { status: 401 });
        if (net.failing) return new Response("down", { status: 502 });
        return json({
          login: "maintainer",
          snapshot: net.snapshot,
          received_at: new Date(NOW).toISOString(),
          age_s: net.ageS,
        });
      }
      if (url === "/changes" && init?.method === "POST") {
        const b = JSON.parse(String(init.body)) as { kind: string; args: Record<string, unknown> };
        net.posts.push(b);
        return json({ id: net.posts.length, at: new Date(NOW).toISOString(), ...b });
      }
      if (url === "/auth/logout") {
        net.loggedOut = true;
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return net;
}

export function mount(path: string, net: Net) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} api={makeApi(net.fetch)} nowFn={() => NOW} pollMs={40} />);
}
