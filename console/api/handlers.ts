import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Table } from "./table.ts";

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}
export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Deps {
  table: Table;
  /** SHA-256 hex of the scheduler's API key (a stack parameter). */
  keyHash: string;
  maintainer: string;
  clientId: string;
  clientSecret: () => Promise<string>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const KINDS = ["set_parameter", "pause_agent", "resume_agent", "undo", "set_parameter_mode"];
const SESSION_DAYS = 30;
const COOKIE = "session";
const STATE_COOKIE = "oauth_state";

const json = (status: number, v: unknown, headers: Record<string, string> = {}): Res => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(v),
});
const text = (status: number, t: string): Res => ({ status, headers: { "content-type": "text/plain" }, body: t });

function cookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Constant-time check of a presented key against the stored SHA-256 hash. */
function keyOk(presented: string | undefined, hash: string): boolean {
  if (!presented || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const a = Buffer.from(createHash("sha256").update(presented).digest("hex"));
  const b = Buffer.from(hash.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (r: Req) => /^Bearer (.+)$/.exec(r.headers.authorization ?? "")?.[1];
async function session(d: Deps, r: Req) {
  const id = cookies(r.headers.cookie)[COOKIE];
  if (!id) return null;
  const s = await d.table.getSession(id);
  if (!s || s.expires_at <= d.now()) return null;
  return s;
}
const cookieAttrs = "HttpOnly; Secure; SameSite=Lax; Path=/";

async function login(d: Deps): Promise<Res> {
  const state = randomBytes(16).toString("hex");
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", d.clientId);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "read:user");
  return {
    status: 302,
    headers: { location: u.toString(), "set-cookie": `${STATE_COOKIE}=${state}; ${cookieAttrs}; Max-Age=600` },
    body: "",
  };
}

async function callback(d: Deps, r: Req): Promise<Res> {
  const now = d.now();
  const deny = async (reason: string, who: string | null = null) => {
    await d.table.recordAttempt({ login: who, ok: false, reason, at: now });
    return text(403, "forbidden");
  };
  const want = cookies(r.headers.cookie)[STATE_COOKIE];
  if (!want || !r.query.state || r.query.state !== want || !r.query.code) return deny("state mismatch");
  let who: string;
  try {
    const tok = await d.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: d.clientId, client_secret: await d.clientSecret(), code: r.query.code }),
    });
    const access = ((await tok.json()) as { access_token?: string }).access_token;
    if (!access) return deny("no token");
    const user = await d.fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${access}`,
        accept: "application/vnd.github+json",
        "user-agent": "panelator-console",
      },
    });
    who = ((await user.json()) as { login?: string }).login ?? "";
  } catch {
    return deny("exchange failed");
  }
  if (!who || who.toLowerCase() !== d.maintainer.toLowerCase()) return deny("not the maintainer", who || null);
  const id = randomBytes(32).toString("hex");
  await d.table.putSession({ id, login: who, expires_at: now + SESSION_DAYS * 86_400_000 });
  await d.table.recordAttempt({ login: who, ok: true, at: now });
  return {
    status: 302,
    headers: { location: "/", "set-cookie": `${COOKIE}=${id}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}` },
    body: "",
  };
}

async function logout(d: Deps, r: Req): Promise<Res> {
  const id = cookies(r.headers.cookie)[COOKIE];
  if (id) await d.table.deleteSession(id);
  return { status: 204, headers: { "set-cookie": `${COOKIE}=; ${cookieAttrs}; Max-Age=0` }, body: "" };
}

async function postChange(d: Deps, r: Req): Promise<Res> {
  const s = await session(d, r);
  if (!s) return text(401, "sign in");
  const origin = r.headers.origin;
  const host = r.headers["x-forwarded-host"] ?? r.headers.host;
  if (!origin || !host || new URL(origin).host !== host) return text(403, "cross-origin");
  let b: { kind?: unknown; args?: unknown };
  try {
    b = JSON.parse(r.body || "{}");
  } catch {
    return text(400, "bad json");
  }
  if (typeof b.kind !== "string" || !KINDS.includes(b.kind)) return text(400, "unknown kind");
  if (typeof b.args !== "object" || b.args === null || Array.isArray(b.args)) return text(400, "bad args");
  return json(
    200,
    await d.table.addChange({
      at: new Date(d.now()).toISOString(),
      by: s.login,
      kind: b.kind,
      args: b.args as Record<string, unknown>,
    }),
  );
}

async function getChanges(d: Deps, r: Req): Promise<Res> {
  const after = Number(r.query.after ?? 0);
  const wait = Math.min(Math.max(Number(r.query.wait ?? 0), 0), 28);
  if (!Number.isFinite(after)) return text(400, "bad after");
  const end = d.now() + wait * 1000;
  for (;;) {
    const list = await d.table.changesAfter(after);
    if (list.length) return json(200, { changes: list.map(({ result: _r, ...c }) => c) });
    if (d.now() >= end) return json(200, { changes: [] });
    await d.sleep(Math.min(2000, end - d.now()));
  }
}

async function postResult(d: Deps, r: Req, id: number): Promise<Res> {
  let b: { status?: unknown; action_id?: unknown; reason?: unknown };
  try {
    b = JSON.parse(r.body || "{}");
  } catch {
    return text(400, "bad json");
  }
  if (b.status !== "applied" && b.status !== "refused") return text(400, "bad status");
  const ok = await d.table.setResult(id, {
    status: b.status,
    ...(typeof b.action_id === "string" ? { action_id: b.action_id } : {}),
    ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
  });
  return ok ? json(200, { ok: true }) : text(404, "no such change");
}

/** Routes one request (spec 051 AC-5, AC-6). The key never opens a browser route and the cookie never a scheduler route. */
export async function handle(d: Deps, r: Req): Promise<Res> {
  const route = `${r.method} ${r.path}`;
  if (route === "GET /auth/login") return login(d);
  if (route === "GET /auth/callback") return callback(d, r);
  if (route === "POST /auth/logout") return logout(d, r);
  const result = /^POST \/changes\/(\d+)\/result$/.exec(route);
  const scheduler = route === "PUT /state" || route === "GET /changes" || result;
  if (scheduler) {
    if (!keyOk(bearer(r), d.keyHash)) return text(401, "key required");
    if (route === "PUT /state") {
      let snap: unknown;
      try {
        snap = JSON.parse(r.body);
      } catch {
        return text(400, "bad json");
      }
      await d.table.putState(snap, d.now());
      return json(200, { ok: true });
    }
    return result ? postResult(d, r, Number(result[1])) : getChanges(d, r);
  }
  if (route === "GET /state") {
    const who = await session(d, r);
    if (!who) return text(401, "sign in");
    const st = await d.table.getState();
    return json(200, {
      snapshot: st?.snapshot ?? null,
      received_at: st ? new Date(st.at).toISOString() : null,
      age_s: st ? Math.max(0, Math.round((d.now() - st.at) / 1000)) : null,
    });
  }
  if (route === "POST /changes") return postChange(d, r);
  return text(404, "not found");
}
