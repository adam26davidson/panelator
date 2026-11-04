import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.ts";
import { KINDS } from "../src/actions/index.ts";
import { approveParty, checkContact, classifyGh, readParties } from "../src/contacts/gate.ts";
import { contactsList, contactsRemove } from "../src/contacts/commands.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { registryActionsCheck } from "../src/actions/index.ts";
import { statePaths, ensureStateDirs } from "../src/state/paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "adam26davidson/panelator";

describe("classifyGh (spec 030 AC-11)", () => {
  it("gates writes to another repository and nothing else", () => {
    expect(classifyGh(["issue", "create", "-R", "other/repo", "--title", "t", "--body", "secret body"], REPO)).toEqual({ party: "github:other", command: "gh issue create -R other/repo" });
    expect(classifyGh(["pr", "comment", "3", "--repo=acme/x", "-b", "x"], REPO)?.party).toBe("github:acme");
    expect(classifyGh(["repo", "fork", "acme/x"], REPO)?.party).toBe("github:acme");
    expect(classifyGh(["api", "-X", "POST", "/repos/acme/x/issues"], REPO)?.party).toBe("github:acme");
    expect(classifyGh(["api", "repos/acme/x/issues", "-f", "title=t"], REPO)?.party).toBe("github:acme");
    expect(classifyGh(["api", "/repos/acme/x/issues"], REPO)).toBeNull();
    expect(classifyGh(["api", "-X", "POST", `/repos/${REPO}/issues`], REPO)).toBeNull();
    expect(classifyGh(["issue", "view", "3", "-R", "acme/x"], REPO)).toBeNull();
    expect(classifyGh(["issue", "create", "-R", REPO, "--title", "t"], REPO)).toBeNull();
    expect(classifyGh(["issue", "create", "--title", "t"], REPO)).toBeNull();
    expect(classifyGh(["pr", "list"], REPO)).toBeNull();
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "contacts-"));
  const paths = statePaths(join(root, "state"));
  const cfg = { ...loadConfig(defaultConfigPath), state_dir: paths.root };
  const defs = loadParameterDefinitions(join(agentsDir, "parameters.yaml"), cfg, loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml"))));
  return { root, paths, parameters: new ParameterStore(paths, defs), log: new ActionLog(paths.actionsLog) };
}

describe("gate, parties and commands (spec 030 AC-11, AC-12)", () => {
  it("refuses an unapproved party, allows an approved one, and the system cannot turn the parameter off", async () => {
    const s = setup();
    await ensureStateDirs(s.paths);
    const r = await checkContact(s, "github:other");
    expect(r).toMatchObject({ allowed: false });
    expect((r as { text: string }).text).toContain("github:other");
    expect((r as { text: string }).text).toContain("first_contact");
    await approveParty(s.paths, { party: "github:other", channel: "github", approved_at: "2026-11-04T00:00:00Z", question_comment_id: 7, issue: 39 });
    expect(await checkContact(s, "github:other")).toEqual({ allowed: true });
    expect(await checkContact(s, "github:else")).toMatchObject({ allowed: false });
    await expect(s.parameters.setParameter("first_contact_needs_approval", false, "credential-check")).rejects.toThrow(/locked/);
    expect(await contactsList(s.paths)).toContain("github:other\tgithub\tapproved 2026-11-04T00:00:00Z\tissue #39\tquestion 7");
    expect(await contactsRemove(s.paths, s.log, "github:other")).toBe("removed github:other");
    expect(await readParties(s.paths)).toEqual([]);
    await expect(contactsRemove(s.paths, s.log, "github:other")).rejects.toThrow(/no approved party/);
    expect((await s.log.list()).filter((e) => e.kind === "contacts_remove").map((e) => e.agent)).toEqual(["maintainer", "maintainer"]);
  });
  it("no action kind writes contacts/parties.json", () => {
    for (const [name] of Object.entries(KINDS)) expect(name).not.toMatch(/contact|part/);
    for (const f of ["set-parameter", "pause-agent", "resume-agent", "run-agent", "rerun-workflow", "undo", "renew-credential"]) {
      const p = join(here, "..", "src", "actions", `${f}.ts`);
      if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toMatch(/contactParties|parties\.json/);
    }
  });
});

describe("the gh shim (spec 030 AC-11)", () => {
  function shimRun(args: string[], approve: boolean) {
    const s = setup();
    const state = s.paths.root;
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "token.json"), '{"token":"tok","expires_at":"x"}');
    const cfgPath = join(s.root, "scheduler.yaml");
    writeFileSync(cfgPath, `repo: ${REPO}\nmaintainer: adam26davidson\napp: {bot_login: bot, id: 1, installation_id: 1}\nstate_dir: ${state}\ncredentials: {dir: ${join(s.root, "creds")}}\n`);
    if (approve) {
      mkdirSync(join(state, "contacts"), { recursive: true });
      writeFileSync(join(state, "contacts", "parties.json"), JSON.stringify([{ party: "github:other", channel: "github", approved_at: "t", question_comment_id: 1, issue: 39 }]));
    }
    const real = join(s.root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "gh"), `#!/bin/sh\necho "$@" >> ${join(s.root, "gh-calls")}\n`);
    chmodSync(join(real, "gh"), 0o755);
    const launcher = join(s.root, "panelator-scheduler");
    writeFileSync(launcher, `#!/bin/sh\nPANELATOR_AGENT=implement exec ${process.execPath} ${join(here, "..", "bin", "scheduler.ts")} --config ${cfgPath} "$@"\n`);
    chmodSync(launcher, 0o755);
    const r = spawnSync(join(here, "..", "bin", "gh"), args, { encoding: "utf8", env: { PATH: `${join(here, "..", "bin")}:${real}:${process.env.PATH}`, PANELATOR_STATE_DIR: state, PANELATOR_SCHEDULER: launcher } });
    return { r, calls: existsSync(join(s.root, "gh-calls")) ? readFileSync(join(s.root, "gh-calls"), "utf8") : "", log: new ActionLog(s.paths.actionsLog) };
  }
  it("refuses gh issue create -R other/repo with no call and one contact_refused entry, then allows it after approval", async () => {
    const refused = shimRun(["issue", "create", "-R", "other/repo", "--title", "t", "--body", "private body"], false);
    expect(refused.r.status).toBe(1);
    expect(refused.r.stderr).toContain("github:other");
    expect(refused.calls).toBe("");
    const rows = (await refused.log.list()).filter((e) => e.kind === "contact_refused");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "implement", status: "refused", args: { party: "github:other", command: "gh issue create -R other/repo" } });
    expect(JSON.stringify(rows[0])).not.toContain("private body");
    const ok = shimRun(["issue", "create", "-R", "other/repo", "--title", "t"], true);
    expect(ok.r.status).toBe(0);
    expect(ok.calls).toContain("issue create -R other/repo");
  });
  it("leaves reads and the configured repository alone", () => {
    expect(shimRun(["issue", "view", "3", "-R", "other/repo"], false).calls).toContain("issue view 3");
    expect(shimRun(["issue", "create", "-R", REPO, "--title", "t"], false).r.status).toBe(0);
    expect(shimRun(["pr", "list"], false).r.status).toBe(0);
  });
});
