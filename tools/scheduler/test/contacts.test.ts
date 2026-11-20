import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { approveParty } from "../src/contacts/approve.ts";
import { contactsCommand } from "../src/contacts/commands.ts";
import { checkContact, readParties } from "../src/contacts/gate.ts";
import { readContactLog } from "../src/contacts/log.ts";
import { checkInstallationScope } from "../src/contacts/scope.ts";
import { createAppClient } from "../src/github/auth.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { generateKeyPairSync } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const mk = async () => {
  const root = mkdtempSync(join(tmpdir(), "contacts-"));
  const paths = statePaths(join(root, "state"));
  await ensureStateDirs(paths);
  return { root, paths };
};
const entry = { party: "example.org", channel: "email", approved_at: "2026-11-20T10:00:00Z", question_comment_id: 5, issue: 9 };
const params = (v: boolean) => ({ read: async () => v }) as never;

describe("contacts gate (spec 099 AC-8, AC-9)", () => {
  it("allows with the parameter off or a listed party, refuses otherwise naming the party", async () => {
    const { paths } = await mk();
    expect(await checkContact({ paths, parameters: params(false) }, "a.org")).toEqual({ status: "allowed" });
    const r = await checkContact({ paths, parameters: params(true) }, "a.org");
    expect(r.status).toBe("refused");
    expect((r as { text: string }).text).toContain("a.org");
    expect((r as { text: string }).text).toContain("first_contact");
    await approveParty(paths, entry);
    expect(await checkContact({ paths, parameters: params(true) }, "example.org")).toEqual({ status: "allowed" });
    expect(await readParties(paths)).toEqual([entry]);
  });
  it("lists and removes, writing the removed line", async () => {
    const { paths } = await mk();
    const deps = { paths, now: () => new Date("2026-11-21T00:00:00Z") };
    expect((await contactsCommand("list", undefined, deps)).lines[0]).toBe("[]");
    await approveParty(paths, entry);
    expect((await contactsCommand("list", undefined, deps)).lines[0]).toContain("example.org");
    expect((await contactsCommand("remove", "nope", deps)).exitCode).toBe(1);
    expect((await contactsCommand("remove", "example.org", deps)).exitCode).toBe(0);
    expect(await readParties(paths)).toEqual([]);
    expect(await readContactLog(paths)).toMatchObject([{ event: "removed", actor: "maintainer", party: "example.org", entry }]);
  });
  it("no action kind writes parties.json", () => {
    const dir = join(here, "..", "src", "actions");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain("parties.json");
  });
});

describe("installation scope (spec 099 AC-11)", () => {
  const app = (installs: { id: number; repository_selection: string }[], repos: string[]) => ({ appInstallations: async () => installs, installationRepositories: async () => repos });
  const ctx = (a: ReturnType<typeof app>) => ({ app: a, installationId: 7, repo: "o/r" });
  it("passes for the configured repository alone", async () => {
    expect(await checkInstallationScope(ctx(app([{ id: 7, repository_selection: "selected" }], ["o/r"])))).toEqual({ status: "ok" });
  });
  it("fails naming a second repository, `all`, and a second installation", async () => {
    const two = await checkInstallationScope(ctx(app([{ id: 7, repository_selection: "selected" }], ["o/r", "o/other"])));
    expect(two).toMatchObject({ status: "failed" });
    expect((two as { reason: string }).reason).toContain("o/other");
    const all = await checkInstallationScope(ctx(app([{ id: 7, repository_selection: "all" }], ["o/r"])));
    expect((all as { reason: string }).reason).toContain("all");
    const second = await checkInstallationScope(ctx(app([{ id: 7, repository_selection: "selected" }, { id: 8, repository_selection: "selected" }], ["o/r"])));
    expect((second as { reason: string }).reason).toContain("8");
  });
  it("calls GET /app/installations and GET /installation/repositories and never GET /app", async () => {
    const k = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      seen.push(`${init?.method ?? "GET"} ${u.pathname}`);
      const json = (b: unknown) => { const r = new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }); Object.defineProperty(r, "url", { value: u.href }); return r; };
      if (u.pathname === "/app/installations") return json([{ id: 7, repository_selection: "selected" }]);
      if (u.pathname === "/app/installations/7/access_tokens") return new Response(JSON.stringify({ token: "t", expires_at: "2030-01-01T00:00:00Z" }), { status: 201, headers: { "content-type": "application/json" } });
      if (u.pathname === "/installation/repositories") return json({ total_count: 1, repositories: [{ full_name: "o/r" }] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const client = createAppClient({ id: 1, installation_id: 7, private_key_path: "", bot_login: "" }, k.privateKey, fetchFn, { retry: false });
    expect(await checkInstallationScope({ app: client, installationId: 7, repo: "o/r" })).toEqual({ status: "ok" });
    expect(seen).toContain("GET /app/installations");
    expect(seen).toContain("GET /installation/repositories");
    expect(seen).not.toContain("GET /app");
  });
  it("the github-app-key entry names the scope", () => {
    expect(readFileSync(join(agentsDir, "credentials.yaml"), "utf8")).toContain("installed on adam26davidson/panelator only (repository_selection: selected)");
  });
});

describe("the gh shim is unchanged (spec 099 AC-10)", () => {
  it("passes -R other/repo through with the token and refuses nothing", async () => {
    const { root, paths } = await mk();
    writeFileSync(paths.root + "/token.json", JSON.stringify({ token: "TOK123", expires_at: "2030-01-01T00:00:00Z" }));
    const down = join(root, "down");
    mkdirSync(down);
    writeFileSync(join(down, "gh"), '#!/bin/sh\necho "TOKEN=$GH_TOKEN"\necho "ARGV=$*"\n', { mode: 0o755 });
    const r = spawnSync(join(here, "..", "bin", "gh"), ["issue", "create", "-R", "other/repo", "--title", "t"], { env: { ...process.env, PANELATOR_STATE_DIR: paths.root, PATH: `${join(here, "..", "bin")}:${down}:${process.env.PATH}` }, encoding: "utf8" });
    expect(r.stdout).toContain("TOKEN=TOK123");
    expect(r.stdout).toContain("ARGV=issue create -R other/repo --title t");
    expect(r.status).toBe(0);
  });
  it("bin/gh is byte-identical to HEAD's", () => {
    const head = spawnSync("git", ["show", "origin/main:tools/scheduler/bin/gh"], { cwd: here, encoding: "utf8" });
    if (head.status === 0) expect(readFileSync(join(here, "..", "bin", "gh"), "utf8")).toBe(head.stdout);
  });
});

describe("stage prompts (spec 099 AC-14)", () => {
  it("each of the five says the token reaches one repository and what a 404 means", () => {
    for (const f of ["plan", "implement", "fix", "review", "spec"]) {
      const text = readFileSync(join(agentsDir, "stages", `${f}.md`), "utf8");
      expect(text, f).toContain("`adam26davidson/panelator`\nonly");
      expect(text, f).toContain("`404` or `403`");
      expect(text, f).toContain("`first_contact` request");
    }
    expect(readFileSync(join(agentsDir, "standing", "credential-check.md"), "utf8")).toContain("renew_credential");
  });
});
