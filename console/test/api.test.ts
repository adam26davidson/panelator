import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Deps, handle, type Req } from "../api/handlers.ts";
import { MemoryTable } from "../api/table.ts";

const KEY = "scheduler-key";
const hash = createHash("sha256").update(KEY).digest("hex");

function setup(login = "maintainer") {
  const table = new MemoryTable();
  let t = 1_000_000;
  const slept: number[] = [];
  const d: Deps = {
    table,
    keyHash: hash,
    maintainer: "maintainer",
    clientId: "cid",
    clientSecret: async () => "shh",
    fetch: async (url) =>
      new Response(JSON.stringify(String(url).includes("access_token") ? { access_token: "tok" } : { login })),
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
  const req = (method: string, path: string, o: Partial<Req> = {}): Req => ({
    method,
    path,
    query: {},
    headers: { host: "c.example" },
    body: "",
    ...o,
  });
  const signIn = async () => {
    const lg = await handle(d, req("GET", "/auth/login"));
    const state = /oauth_state=([0-9a-f]+)/.exec(lg.headers["set-cookie"])?.[1] ?? "";
    const cb = await handle(
      d,
      req("GET", "/auth/callback", {
        query: { code: "c", state },
        headers: { host: "c.example", cookie: `oauth_state=${state}` },
      }),
    );
    return { cb, cookie: /session=([0-9a-f]+)/.exec(cb.headers["set-cookie"] ?? "")?.[1] };
  };
  return {
    d,
    table,
    req,
    signIn,
    slept,
    tick: (ms: number) => {
      t += ms;
    },
  };
}
const auth = (k = KEY) => ({ authorization: `Bearer ${k}`, host: "c.example" });

describe("sign-in (AC-5)", () => {
  it("creates a 30-day HttpOnly Secure SameSite=Lax session for the maintainer", async () => {
    const { cb, cookie } = await setup().signIn();
    expect(cb.status).toBe(302);
    expect(cb.headers["set-cookie"]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(cb.headers["set-cookie"]).toContain(`Max-Age=${30 * 86400}`);
    expect(cookie).toBeTruthy();
  });
  it("returns 403 with no session for another login, records the attempt", async () => {
    const s = setup("someone-else");
    const { cb } = await s.signIn();
    expect(cb.status).toBe(403);
    expect(cb.headers["set-cookie"]).toBeUndefined();
    expect(s.table.sessions.size).toBe(0);
    expect(s.table.attempts).toMatchObject([{ login: "someone-else", ok: false }]);
    // The browser is sent on to the app's refusal card, which names the login.
    expect(cb.headers["content-type"]).toContain("text/html");
    expect(cb.body).toContain("url=/?refused=someone-else");
  });
  it("returns to the screen whose link was opened, and only to a path of this site", async () => {
    const s = setup();
    const go = async (ret: string) => {
      const lg = await handle(s.d, s.req("GET", "/auth/login", { query: { return: ret } }));
      const ck = /oauth_state=([^;]+)/.exec(lg.headers["set-cookie"])?.[1] ?? "";
      const state = ck.split(".")[0];
      return handle(
        s.d,
        s.req("GET", "/auth/callback", {
          query: { code: "c", state },
          headers: { host: "c.example", cookie: `oauth_state=${ck}` },
        }),
      );
    };
    expect((await go("/questions")).headers.location).toBe("/questions");
    expect((await go("//evil.example")).headers.location).toBe("/");
    expect((await go("https://evil.example")).headers.location).toBe("/");
  });
  it("returns 403 for a state mismatch", async () => {
    const s = setup();
    const r = await handle(
      s.d,
      s.req("GET", "/auth/callback", {
        query: { code: "c", state: "a" },
        headers: { host: "c.example", cookie: "oauth_state=b" },
      }),
    );
    expect(r.status).toBe(403);
    expect(s.table.sessions.size).toBe(0);
    expect(s.table.attempts).toHaveLength(1);
  });
  it("logout ends the session", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    const h = { host: "c.example", cookie: `session=${cookie}` };
    expect((await handle(s.d, s.req("GET", "/state", { headers: h }))).status).toBe(200);
    expect((await handle(s.d, s.req("POST", "/auth/logout", { headers: h }))).status).toBe(204);
    expect((await handle(s.d, s.req("GET", "/state", { headers: h }))).status).toBe(401);
  });
  it("a session past its expiry is refused", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    s.tick(31 * 86_400_000);
    expect(
      (await handle(s.d, s.req("GET", "/state", { headers: { host: "c.example", cookie: `session=${cookie}` } })))
        .status,
    ).toBe(401);
  });
});

describe("routes (AC-5, AC-6)", () => {
  it("the key and the cookie are not interchangeable", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    const ck = { host: "c.example", cookie: `session=${cookie}` };
    expect((await handle(s.d, s.req("PUT", "/state", { headers: ck, body: "{}" }))).status).toBe(401);
    expect((await handle(s.d, s.req("GET", "/changes", { headers: ck }))).status).toBe(401);
    expect((await handle(s.d, s.req("GET", "/state", { headers: auth() }))).status).toBe(401);
    expect(
      (
        await handle(
          s.d,
          s.req("POST", "/changes", { headers: { ...auth(), origin: "https://c.example" }, body: "{}" }),
        )
      ).status,
    ).toBe(401);
    expect((await handle(s.d, s.req("PUT", "/state", { headers: auth("wrong"), body: "{}" }))).status).toBe(401);
  });
  it("stores the pushed snapshot and returns it with its age", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    expect((await handle(s.d, s.req("PUT", "/state", { headers: auth(), body: '{"tick_s":45}' }))).status).toBe(200);
    s.tick(7000);
    const r = await handle(
      s.d,
      s.req("GET", "/state", { headers: { host: "c.example", cookie: `session=${cookie}` } }),
    );
    expect(JSON.parse(r.body)).toMatchObject({ snapshot: { tick_s: 45 }, age_s: 7, login: "maintainer" });
  });
  it("POST /changes enforces a same-origin Origin and the five kinds, with increasing ids", async () => {
    const s = setup();
    const { cookie } = await s.signIn();
    const post = (body: unknown, origin: string | null = "https://c.example") =>
      handle(
        s.d,
        s.req("POST", "/changes", {
          headers: { host: "c.example", cookie: `session=${cookie}`, ...(origin ? { origin } : {}) },
          body: JSON.stringify(body),
        }),
      );
    expect((await post({ kind: "pause_agent", args: { name: "a" } }, "https://evil.example")).status).toBe(403);
    expect((await post({ kind: "pause_agent", args: { name: "a" } }, null)).status).toBe(403);
    expect((await post({ kind: "run_agent", args: {} })).status).toBe(400);
    const a = JSON.parse((await post({ kind: "pause_agent", args: { name: "a" } })).body);
    const b = JSON.parse((await post({ kind: "undo", args: { action_id: "x" } })).body);
    expect(a).toMatchObject({ id: 1, by: "maintainer", kind: "pause_agent" });
    expect(b.id).toBe(2);
  });
  it("long-poll returns at once on a new change and empty after wait", async () => {
    const s = setup();
    await s.table.addChange({ at: "t", by: "maintainer", kind: "pause_agent", args: { name: "a" } });
    const now = await handle(s.d, s.req("GET", "/changes", { headers: auth(), query: { after: "0", wait: "25" } }));
    expect(JSON.parse(now.body).changes).toHaveLength(1);
    expect(s.slept).toEqual([]);
    const none = await handle(s.d, s.req("GET", "/changes", { headers: auth(), query: { after: "1", wait: "40" } }));
    expect(JSON.parse(none.body).changes).toEqual([]);
    expect(s.slept.every((m) => m <= 2000)).toBe(true);
    expect(s.slept.reduce((a, b) => a + b, 0)).toBe(28_000);
  });
  it("stores a change's result", async () => {
    const s = setup();
    const c = await s.table.addChange({ at: "t", by: "maintainer", kind: "pause_agent", args: {} });
    const r = await handle(
      s.d,
      s.req("POST", `/changes/${c.id}/result`, { headers: auth(), body: '{"status":"refused","reason":"nope"}' }),
    );
    expect(r.status).toBe(200);
    expect(s.table.changes[0].result).toEqual({ status: "refused", reason: "nope" });
    expect(
      (await handle(s.d, s.req("POST", "/changes/9/result", { headers: auth(), body: '{"status":"applied"}' }))).status,
    ).toBe(404);
  });
});
