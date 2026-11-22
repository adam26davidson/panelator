import type { SentChange, StateResponse } from "./types.ts";

export class Unauthorized extends Error {}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Api {
  getState(): Promise<StateResponse>;
  postChange(kind: string, args: Record<string, unknown>): Promise<SentChange>;
  logout(): Promise<void>;
}

/** The browser's calls to the console API, same origin; a 401 means no session (spec 051 AC-14). */
export function makeApi(f: Fetch = (url, init) => fetch(url, init)): Api {
  return {
    async getState() {
      const r = await f("/state", { credentials: "same-origin" });
      if (r.status === 401) throw new Unauthorized("no session");
      if (!r.ok) throw new Error(`GET /state answered ${r.status}`);
      return (await r.json()) as StateResponse;
    },
    async postChange(kind, args) {
      const r = await f("/changes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, args }),
      });
      if (r.status === 401) throw new Unauthorized("no session");
      if (!r.ok) throw new Error(`POST /changes answered ${r.status}`);
      return (await r.json()) as SentChange;
    },
    async logout() {
      await f("/auth/logout", { method: "POST", credentials: "same-origin" });
    },
  };
}
