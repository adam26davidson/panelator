import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { Scheduler } from "../src/service/loop.ts";
import type { StageRun } from "../src/adapters/types.ts";
import { listPaused } from "../src/state/paused.ts";
import { readAgentState } from '../src/standing/state.ts';
import { runStandingAgent } from '../src/standing/run.ts';
import { chainWorld, standingWorld, type ChainWorld } from "./helpers/e2e-routes.ts";
import { withDesign } from "./helpers/repo-pair.ts";
import { PARENT, repoFiles, PLAN, APPROVE, CHANGES, ask, SEND, agents, expectSettled, inputsOf, runsOf, rev, asksAfterPushing, kinds, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-9");

// ---------------------------------------------------------------------------------------------------------------
// Spec 029 section 6: the design stage, recorded through the real Scheduler, driver and machine.

describe("end to end: the design stage (spec 029)", () => {
  const uiSpec = () => readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8").replace("Parent: docs/top.md", `Parent: ${PARENT}`);
  const SCREENS = ["editor-empty", "editor-populated"];
  const DESIGN = "specs/010-thing/design/";
  const uiFiles = (design: boolean) => {
    const files = { ...repoFiles(), "specs/010-thing/spec.md": uiSpec() };
    return design ? withDesign(files, "specs/010-thing/spec.md", SCREENS) : files;
  };
  /** A design run's git work: a story and the renders (all three sizes unless `drop` names one), the PR, and the result. */
  const design = (w: () => ChainWorld, n: number, o: { drop?: string; tag?: string; renders?: number; screens?: string[] } = {}) => (run: StageRun) => {
    const screens = o.screens ?? SCREENS;
    const files: Record<string, string> = { [`${DESIGN}editor.stories.tsx`]: `export default {}; // ${o.tag ?? "a"}\n` };
    for (const s of screens) for (const suffix of ["", ".mobile", ".tablet"]) if (`${s}${suffix}.png` !== o.drop) files[`${DESIGN}${s}${suffix}.png`] = `png ${o.tag ?? "a"}\n`;
    const sha = w().push(run, files, "design");
    w().openPr(run, n, sha, `Refs #7\n\n![editor-empty](${DESIGN}editor-empty.png)`);
    const renders = ["x.png", "x.mobile.png", "x.tablet.png"].slice(0, o.renders ?? 3);
    return { verdict: "designed", spec_path: "specs/010-thing/spec.md", pr_number: n, head_sha: sha, screens: screens.map((name) => ({ name, stories: [`${name}--default`], renders })) };
  };
  const newMerge = (w: ChainWorld) => w.mergeRequests;

  it("runs the design stage on design-7 for a UI spec without design/, reviews it with the design profile, fixes, merges, then plans (AC-1, AC-3, AC-4)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: uiFiles(false),
      results: {
        design: [design(() => w, 12)],
        review: [CHANGES, APPROVE, APPROVE],
        fix: [a.fix({ [`${DESIGN}editor-empty.png`]: "re-rendered\n" })],
        plan: [PLAN], implement: [a.implement(13)],
      },
    });
    expect((await w.tick()).claimed).toEqual([7]);
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["design", "review", "fix", "review", "plan", "implement", "review"]);
    const [d] = runsOf(w, "design");
    expect(d).toMatchObject({ branch: "design-7", profile: "design" });
    expect(d.input).toMatchObject({ spec_path: "specs/010-thing/spec.md", viewports: expect.stringContaining("desktop 1440x900") });
    expect(d.input.design_problem).toMatch(/editor-empty\.mobile\.png/);
    expect(runsOf(w, "review").map((r) => [r.branch, r.profile])).toEqual([["design-7", "design"], ["design-7", "design"], ["issue-7", "backend"]]);
    expect(runsOf(w, "fix")[0]).toMatchObject({ branch: "design-7", profile: "design", model: d.model });
    expect(runsOf(w, "review")[0].input.pr?.number).toBe(12);
    expect(newMerge(w)).toEqual([12, 13]);
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/design-7");
    expect(w.onMain(`${DESIGN}editor-populated.tablet.png`)).not.toBeNull();
    expect(w.onMain(`${DESIGN}editor-empty.png`)).toBe("re-rendered\n");
    // The plan runs on issue-7 from the merged design, with fresh counters.
    expect(runsOf(w, "plan")[0].branch).toBe("issue-7");
    expect(w.issueOpen).toBe(false);
    // No code path applies needs-design-stage, and nothing is commented.
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 180_000);

  it("an implement question recorded through the spec track changes the UI design section: the design stage runs, its PR is fixed and merged, then plan runs with the held work (spec 057 AC-1, AC-2; spec 029 AC-4)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const held = { head: "" };
    const starts: string[] = [];
    const THIRD = "editor-saving";
    const record = (run: StageRun) => {
      const mark = `(maintainer answer, question #${w.questions()[0].id})`;
      const text = uiSpec().replace("Screens: editor-empty, editor-populated", `Screens: editor-empty, editor-populated, ${THIRD}`).replace("Flow: open -> edit -> save.", `Flow: open -> edit -> save ${mark}.`);
      return a.spec(12, { "specs/010-thing/spec.md": text })(run);
    };
    w = await chainWorld({
      files: uiFiles(true),
      results: {
        plan: [PLAN, PLAN],
        implement: [asksAfterPushing(() => w, ask("technical", "Does saving need its own screen?"), held), a.implement(13, { "a.txt": "pr 13\n" }, (run) => starts.push(rev(run)))],
        "question-check": [SEND], spec: [record],
        review: [APPROVE, CHANGES, APPROVE, APPROVE],
        design: [design(() => w, 14, { screens: [...SCREENS, THIRD] })],
        fix: [a.fix({ [`${DESIGN}editor-empty.png`]: "re-rendered\n" })],
      },
    });
    await w.tick();
    w.reply("Yes, a third screen.");
    await w.tick();
    await expectSettled(w);

    // AC-1: the whole path, in order.
    expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "spec", "review", "design", "review", "fix", "review", "plan", "implement", "review"]);
    expect(w.mergeRequests).toEqual([12, 14, 13]);
    expect(runsOf(w, "spec")[0]).toMatchObject({ branch: "spec-7" });
    expect(runsOf(w, "spec")[0].input.mode).toBe("record");
    const [d] = runsOf(w, "design");
    expect(d).toMatchObject({ branch: "design-7", profile: "design" });
    for (const f of [`${THIRD}.png`, `${THIRD}.mobile.png`, `${THIRD}.tablet.png`]) expect(d.input.design_problem).toContain(f);
    expect(d.input.design_problem).not.toMatch(/editor-empty|editor-populated/);
    expect(runsOf(w, "review").map((r) => [r.branch, r.profile])).toEqual([["spec-7", "spec"], ["design-7", "design"], ["design-7", "design"], ["issue-7", "backend"]]);
    expect(runsOf(w, "fix")[0]).toMatchObject({ branch: "design-7", profile: "design" });
    expect(w.onMain(`${DESIGN}${THIRD}.tablet.png`)).not.toBeNull();
    expect(w.labelLog).toEqual(["+in-progress", "+needs-decision", "-in-progress", "+in-progress", "-needs-decision", "-in-progress"]);

    // AC-2: held work crosses both merges.
    expect(inputsOf(w, "plan")[1].held_work).toContain(held.head);
    expect(inputsOf(w, "plan")[1].held_work).toContain("issue-7");
    expect(starts).toEqual([held.head]);
    expect(runsOf(w, "implement")[1].branch).toBe("issue-7");
    for (const stage of ["design", "spec", "question-check", "plan"]) expect(inputsOf(w, stage)[0].held_work).toBeUndefined();
    expect(kinds(w, "held-work")).toMatchObject([{ issue: 7, stage: "implement", branch: "issue-7", head: held.head, pushed: true }]);
    expect(kinds(w, "held-work-kept").length).toBeGreaterThanOrEqual(2);
    for (const e of kinds(w, "held-work-kept")) expect(e).toMatchObject({ issue: 7, branch: "issue-7", head: held.head });
    for (const k of ["stale-branch-dropped", "recovered-commits", "held-work-lost"]) expect(kinds(w, k)).toEqual([]);
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/design-7");
    expect(w.writes()).not.toContain("DELETE /repos/o/r/git/refs/heads/issue-7");
    expect(inputsOf(w, "plan")[1].history).toContain("spec merged, UI-design gate failed:");
    expect(inputsOf(w, "plan")[1].history).toContain(`${THIRD}.mobile.png`);
  }, 240_000);

  it("fails a design result with a screen of fewer than three renders as an invalid result, then accepts the retry (AC-2)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: uiFiles(false),
      results: { design: [design(() => w, 12, { renders: 2 }), design(() => w, 12)], review: [APPROVE, APPROVE], plan: [PLAN], implement: [a.implement(13)] },
    });
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran.slice(0, 3)).toEqual(["design", "design", "review"]);
    const first = readdirSync(w.paths.runs).find((r) => r.startsWith("7-design-1-"))!;
    expect(readFileSync(join(w.paths.runs, first, "outcome.json"), "utf8")).toMatch(/renders/);
    expect(inputsOf(w, "design")[1].history).toContain("design attempt 1 failed: result: invalid");
    expect(newMerge(w)).toEqual([12, 13]);
  }, 180_000);

  it("sends the spec agent in revise mode when the gate still fails after two design merges, then designs again (AC-4)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const revisedSpec = uiSpec().replace("A screen.", "A screen, simpler.");
    const specRun = (run: StageRun) => {
      const sha = w.push(run, { "specs/010-thing/spec.md": revisedSpec }, "spec");
      w.openPr(run, 14, sha, "Refs #7\n\nRevised UI design section");
      return { verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 14, head_sha: sha };
    };
    w = await chainWorld({
      files: uiFiles(false),
      results: {
        design: [design(() => w, 12, { drop: "editor-populated.tablet.png" }), design(() => w, 13, { drop: "editor-populated.tablet.png", tag: "b" }), design(() => w, 15, { tag: "c" })],
        spec: [specRun],
        review: [APPROVE, APPROVE, APPROVE, APPROVE, APPROVE],
        plan: [PLAN], implement: [a.implement(16)],
      },
    });
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["design", "review", "design", "review", "spec", "review", "design", "review", "plan", "implement", "review"]);
    const [spec1] = runsOf(w, "spec");
    expect(spec1.input.mode).toBe("revise");
    expect(spec1.input.spec_problem).toContain("the design stage could not satisfy the UI design section");
    expect(spec1.input.spec_problem).toContain("editor-populated.tablet.png");
    expect(runsOf(w, "design").map((r) => r.branch)).toEqual(["design-7", "design-7", "design-7"]);
    expect(newMerge(w)).toEqual([12, 13, 14, 15, 16]);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
  }, 240_000);

  it("removes needs-design-stage from a parked issue once, with one comment, and a restart comments nothing (AC-8)", async () => {
    const w = await chainWorld({ files: uiFiles(true), labels: ["validated", "class:product", "needs-design-stage", "blocked"], results: {} });
    await w.tick();
    expect(w.labelLog).toEqual(["-needs-design-stage"]);
    expect(w.comments.map((c) => c.body)).toEqual([expect.stringContaining("design stage now exists")]);
    expect(JSON.parse(readFileSync(w.paths.designRelabelled, "utf8"))).toEqual([7]);
    // The label comes back; a new Scheduler over the same state directory leaves the issue alone.
    w.labels.add("needs-design-stage");
    w.labelLog.length = 0;
    await new Scheduler(w.deps).tick();
    expect(w.labelLog).toEqual([]);
    expect(w.comments).toHaveLength(1);
    expect(w.adapter.ran).toEqual([]);
  }, 120_000);
});
describe('requests, alerts and the credential check (spec 099 section 6)', () => {
  const FAKE_CREDS = join(import.meta.dirname, 'helpers', 'fake-systemd-creds');
  const cred = { type: 'credential', name: 'telegram-bot', provider: 'telegram', access: ['send messages'], setup: ['create the bot', 'cred set telegram-bot'] };
  const firstContact = { type: 'first_contact', party: 'example.org', channel: 'email', why: 'a question only they can answer', message: 'Hello\nthere' };
  async function requestWorld(request: Record<string, unknown>) {
    let w!: ChainWorld; const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), results: { plan: [{ escalation: { ...ask('capability', 'Can you do it?'), request } }, PLAN], implement: [a.implement(9)], review: [APPROVE], 'question-check': [SEND] } });
    const server = await fakeTelegram();
    w.deps.telegram = telegramChannel(new TelegramClient('SECRET', 42, server.url));
    const { CredentialStore } = await import('../src/credentials/store.ts');
    const { loadCatalogue, profileNames } = await import('../src/credentials/catalogue.ts');
    const store = new CredentialStore({ dir: join(w.pair.root, 'cred-store'), systemdCreds: FAKE_CREDS });
    await store.writeSecret('telegram-bot', JSON.stringify({ bot_token: '123:abc', chat_id: 42 }), 'maintainer');
    w.deps.catalogue = loadCatalogue(join(agentsDir, 'credentials.yaml'), { profiles: profileNames(agentsDir), agents: Object.keys(w.deps.registry ?? {}).concat(['action-audit', 'charter-reflection', 'credential-check', 'delivery-reflection', 'findings-filer', 'infra-health', 'meta-reflection']) });
    w.deps.checkContext = { store, app: w.deps.cfg.app, telegramBaseUrl: server.url, now: () => new Date() };
    return { w, server };
  }
  const press = async (w: ChainWorld, server: Awaited<ReturnType<typeof fakeTelegram>>, n: number) => {
    const [r] = await listPaused(w.paths);
    const u = { update_id: 1, callback_query: { id: 'cb', data: `r:${r.nonce}:${n}`, message: { message_id: r.telegram!.message_id!, date: Math.floor(Date.now() / 1000), chat: { id: 42 } } } };
    await w.scheduler.handleTelegramUpdate(u); await w.scheduler.confirmTelegramUpdate(u); await w.tick();
    return readFileSync(w.paths.questionsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'answered');
  };
  it('a credential request is sent with Done / Can\'t do this; Done runs the check and the stage resumes with done (verified)', async () => {
    const { w, server } = await requestWorld(cred);
    try {
      await w.tick();
      const sent = server.sent[0]!;
      expect((sent.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((r) => r[0]!.text)).toEqual(['Done', "Can't do this"]);
      expect(String(sent.text)).toContain('1. create the bot');
      const entry = await press(w, server, 1);
      expect(entry).toMatchObject({ answer: 'done (verified)', outcome: 'verified', request: { type: 'credential' } });
      expect(w.mergeRequests).toEqual([9]);
      expect(JSON.stringify(w.logs)).not.toContain('123:abc');
    } finally { await server.close(); }
  }, 120000);
  it('the same with the check failing: done (check failed: ...)', async () => {
    const { w, server } = await requestWorld(cred);
    try {
      await w.tick();
      server.fail('getMe', 401);
      const entry = await press(w, server, 1);
      expect(entry).toMatchObject({ answer: 'done (check failed: unauthorized)', outcome: 'check_failed' });
    } finally { await server.close(); }
  }, 120000);
  it('a first-contact request approved by button registers the party and tells the stage no channel can reach it; no other repository is touched', async () => {
    const { w, server } = await requestWorld(firstContact);
    try {
      await w.tick();
      expect(String(server.sent[0]!.text)).toContain('> Hello\n> there');
      const entry = await press(w, server, 1);
      expect(entry).toMatchObject({ outcome: 'approved' });
      expect(entry.answer).toBe('approved (recorded; no channel can reach example.org yet: a credential that can is a credential request)');
      const { readParties } = await import('../src/contacts/gate.ts');
      expect((await readParties(w.paths)).map((p) => p.party)).toEqual(['example.org']);
      expect(w.gh.unmatched).toEqual([]);
      expect(w.mergeRequests).toEqual([9]);
    } finally { await server.close(); }
  }, 120000);
  it('an infra notification reaches the chat (channel telegram), a refused send falls back to the log, and a reply to an alert gets "alerts take no reply"', async () => {
    let w!: ChainWorld; w = await chainWorld({ files: repoFiles(), results: {} });
    const server = await fakeTelegram();
    try {
      const channel = telegramChannel(new TelegramClient('SECRET', 42, server.url));
      w.deps.telegram = channel;
      const { TelegramNotifier } = await import('../src/notify/telegram.ts');
      const { LogNotifier } = await import('../src/notify/log.ts');
      const notifier = TelegramNotifier(new LogNotifier(w.paths.serviceLog), { telegram: () => channel, alertsPath: w.paths.telegramAlerts, outboxPath: w.paths.telegramOutbox, now: () => new Date(), log: () => {} });
      expect(await notifier.notify({ issue: 0, gate: 'infra', label: 'disk', text: 'volume full' })).toEqual({ channel: 'telegram' });
      expect(server.sent[0]!.text).toBe('infra: disk\n\nvolume full');
      server.fail('sendMessage', 500);
      expect(await notifier.notify({ issue: 0, gate: 'infra', label: 'disk2', text: 'again' })).toEqual({ channel: 'queued' });
      const lines = readFileSync(w.paths.serviceLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines.filter((l) => l.kind === 'notify').map((l) => l.channel)).toEqual(['telegram', 'queued']);
      const u = { update_id: 3, message: { message_id: 2000, date: Math.floor(Date.now() / 1000), chat: { id: 42 }, text: 'ok thanks', reply_to_message: { message_id: 1 } } };
      await w.scheduler.handleTelegramUpdate(u);
      expect(String(server.sent.at(-1)!.text)).toContain('Alerts take no reply');
    } finally { await server.close(); }
  }, 60000);
  it('the credential check woken for an entry near expiry sends one credential-expiry notification and nothing twice that day; a scope failure sends one contact-scope notification', async () => {
    const { loadCatalogue } = await import('../src/credentials/catalogue.ts');
    const { CredentialStore } = await import('../src/credentials/store.ts');
    const w = await standingWorld({ 'credential-check': [{ summary: 'one warning', warnings: [{ name: 'fake-token', expires_at: '2026-10-04T00:00:00Z', steps: ['rotate by hand'] }] }, { summary: 'again', warnings: [{ name: 'fake-token', expires_at: '2026-10-04T00:00:00Z', steps: ['rotate by hand'] }] }] });
    const store = new CredentialStore({ dir: join(w.pair.root, 'cred-store'), systemdCreds: FAKE_CREDS });
    await store.writeSecret('fake-token', 's', 'maintainer');
    const catalogue = loadCatalogue(join(import.meta.dirname, 'fixtures', 'test-catalogue.yaml'), { profiles: ['backend'], agents: [] });
    const deps = { ...w.deps, parameters: w.parameters, catalogue, checkContext: { store, app: w.deps.cfg.app, now: () => w.deps.now() }, scope: async () => ({ status: 'failed' as const, reason: 'the installation also reaches o/other' }) };
    w.setNow(new Date('2026-10-01T12:00:00Z'));
    const def = w.registry['credential-check']!;
    await runStandingAgent(deps as never, def, (await readAgentState(w.paths, 'credential-check'))!);
    const keys = () => w.notifications.map((n) => `${n.gate}:${n.label}`);
    expect(keys().filter((k) => k === 'credential-expiry:fake-token')).toHaveLength(1);
    expect(keys().filter((k) => k === 'infra:contact-scope')).toHaveLength(1);
    expect(w.notifications.find((n) => n.gate === 'credential-expiry')!.text).toContain('1. Run fakecmd --renew');
    w.setNow(new Date('2026-10-01T18:00:00Z'));
    await runStandingAgent(deps as never, def, (await readAgentState(w.paths, 'credential-check'))!);
    expect(keys().filter((k) => k === 'credential-expiry:fake-token')).toHaveLength(1);
  }, 60000);
});
