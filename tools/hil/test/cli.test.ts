import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliDeps } from "../src/cli.ts";
import { schemaErrors, type HilResult } from "../src/result.ts";
import { bootLines, FakeClock, FakeFlasher, FakeSerial, makeBuild, MAIN_SHA, SHA, banner, status } from "./fakes.ts";
import { storeLastGood } from "../src/last-good.ts";

interface Req { method: string; url: string; body: any; auth: string | null }

function setup(scripts: string[][], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hil-cli-"));
  const clock = new FakeClock();
  const flasher = new FakeFlasher();
  const serial = new FakeSerial(clock, scripts);
  const reqs: Req[] = [];
  const out: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    reqs.push({ method: init.method!, url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization ?? null });
    return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
  }) as unknown as typeof fetch;
  const deps: CliDeps = {
    env: {
      GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "tok", GITHUB_RUN_ID: "77", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: "merge".padEnd(40, "0"),
      GITHUB_REF: "refs/pull/1/merge", PANELATOR_HIL_CACHE: join(dir, "cache"), ...env,
    },
    fetch: fakeFetch, hardware: { flasher, serial }, clock, out: (l) => out.push(l),
    listPorts: () => ["usb-1a86_USB_Serial-if00-port0"], portExists: () => true, isAlive: () => true,
  };
  const flags = ["--sha", SHA, "--result", join(dir, "hil-result.json"), "--state", join(dir, "check-run.json")];
  return { dir, deps, flasher, serial, reqs, out, flags };
}

describe("the check run (AC-10)", () => {
  it("creates it in_progress, then completes it success with exactly the result JSON on a pass", async () => {
    const t = setup([bootLines(SHA)]);
    expect(await main(["start", ...t.flags], t.deps)).toBe(0);
    expect(t.reqs[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/o/r/check-runs", auth: "Bearer tok", body: { name: "hil", head_sha: SHA, status: "in_progress" } });
    const build = makeBuild();
    expect(await main(["run", ...t.flags, "--build-dir", build], t.deps)).toBe(0);
    expect(t.reqs).toHaveLength(2);
    const done = t.reqs[1]!;
    expect(done).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/o/r/check-runs/4242", body: { status: "completed", conclusion: "success" } });
    const file = readFileSync(join(t.dir, "hil-result.json"), "utf8");
    expect(done.body.output.text).toBe(file);
    expect(done.body.output.title).toBe("hil: pass");
    expect(done.body.output.summary).toBe("boot-banner: pass");
    const result = JSON.parse(file) as HilResult;
    expect(schemaErrors(result)).toBeNull();
    expect(result).toMatchObject({ outcome: "pass", kind: "pr", sha: SHA, run_id: 77 });
  });

  it.each([
    ["fail", [[]], MAIN_SHA],
  ])("completes with conclusion failure and exit 1 for %s", async (_name, scripts) => {
    const t = setup(scripts as string[][]);
    await main(["start", ...t.flags], t.deps);
    expect(await main(["run", ...t.flags, "--build-dir", makeBuild()], t.deps)).toBe(1);
    expect(t.reqs[1]!.body).toMatchObject({ conclusion: "failure", output: { title: "hil: fail" } });
  });

  it("completes failure for absent and bricked", async () => {
    const a = setup([]);
    a.deps.listPorts = () => [];
    await main(["start", ...a.flags], a.deps);
    expect(await main(["run", ...a.flags, "--build-dir", makeBuild()], a.deps)).toBe(1);
    expect(a.reqs[1]!.body).toMatchObject({ conclusion: "failure", output: { title: "hil: absent" } });
    const b = setup([]);
    b.flasher.chip = [false, false];
    await main(["start", ...b.flags], b.deps);
    expect(await main(["run", ...b.flags, "--build-dir", makeBuild()], b.deps)).toBe(1);
    expect(b.reqs[1]!.body).toMatchObject({ conclusion: "failure", output: { title: "hil: bricked" } });
  });

  it("a soak run is kind soak and flashes nothing; --check-name renames the check", async () => {
    const t = setup([[status(MAIN_SHA)]], { GITHUB_EVENT_NAME: "schedule" });
    await main(["start", ...t.flags, "--check-name", "hil-x"], t.deps);
    expect(t.reqs[0]!.body.name).toBe("hil-x");
    expect(await main(["run", ...t.flags], t.deps)).toBe(0);
    expect(JSON.parse(t.reqs[1]!.body.output.text).kind).toBe("soak");
    expect(t.flasher.calls).toEqual([]);
  });

  it("--build-failed posts one failed 'build' test naming the run's URL", async () => {
    const t = setup([[status(MAIN_SHA)]]);
    await main(["start", ...t.flags], t.deps);
    expect(await main(["run", ...t.flags, "--build-failed"], t.deps)).toBe(1);
    const r = JSON.parse(t.reqs[1]!.body.output.text) as HilResult;
    expect(r.tests).toHaveLength(1);
    expect(r.tests[0]!.message).toContain("https://github.com/o/r/actions/runs/77");
  });

  it("an error in the run still completes the check, as a failed 'harness' test", async () => {
    const t = setup([bootLines(SHA)]);
    t.flasher.throwOnFlash = true;
    await main(["start", ...t.flags], t.deps);
    expect(await main(["run", ...t.flags, "--build-dir", makeBuild()], t.deps)).toBe(1);
    expect(t.reqs[1]!.body.conclusion).toBe("failure");
    expect(JSON.parse(t.reqs[1]!.body.output.text).tests[0]).toMatchObject({ name: "harness", message: "docker exploded" });
  });

  it("run creates the check itself when 'start' left no state", async () => {
    const t = setup([bootLines(SHA)]);
    await main(["run", ...t.flags, "--build-dir", makeBuild()], t.deps);
    expect(t.reqs.map((r) => r.method)).toEqual(["POST", "PATCH"]);
  });
});

describe("complete-failed (AC-11)", () => {
  it("does nothing when a result was written", async () => {
    const t = setup([]);
    writeFileSync(join(t.dir, "hil-result.json"), "{}");
    expect(await main(["complete-failed", ...t.flags], t.deps)).toBe(0);
    expect(t.reqs).toEqual([]);
  });
  it("completes the started check as a failed 'harness' when no result exists", async () => {
    const t = setup([]);
    await main(["start", ...t.flags], t.deps);
    expect(await main(["complete-failed", ...t.flags], t.deps)).toBe(1);
    expect(t.reqs[1]!.body).toMatchObject({ conclusion: "failure", output: { title: "hil: fail" } });
    const r = JSON.parse(t.reqs[1]!.body.output.text) as HilResult;
    expect(schemaErrors(r)).toBeNull();
    expect(r.tests[0]!.name).toBe("harness");
    expect(existsSync(join(t.dir, "hil-result.json"))).toBe(true);
  });
});

describe("restore (AC-13)", () => {
  it("flashes the last-good image, prints the banner's commit and exits 0", async () => {
    const t = setup([[banner(MAIN_SHA)]]);
    storeLastGood(join(t.dir, "cache"), makeBuild(), MAIN_SHA);
    expect(await main(["restore"], t.deps)).toBe(0);
    expect(t.out).toEqual([`restored: ${MAIN_SHA}`]);
    expect(t.flasher.calls).toHaveLength(1);
    expect(t.flasher.calls[0]).toMatch(/last-good$/);
  });
  it("exits 1 with one line for no last-good image, no port, a failed flash and no banner", async () => {
    const none = setup([]);
    expect(await main(["restore"], none.deps)).toBe(1);
    expect(none.out).toHaveLength(1);
    expect(none.out[0]).toMatch(/no last-good image/);

    const noPort = setup([]);
    storeLastGood(join(noPort.dir, "cache"), makeBuild(), MAIN_SHA);
    noPort.deps.listPorts = () => [];
    expect(await main(["restore"], noPort.deps)).toBe(1);
    expect(noPort.out[0]).toMatch(/no port/);

    const badFlash = setup([]);
    storeLastGood(join(badFlash.dir, "cache"), makeBuild(), MAIN_SHA);
    badFlash.flasher.flashes = [false];
    expect(await main(["restore"], badFlash.deps)).toBe(1);
    expect(badFlash.out[0]).toMatch(/flash failed/);

    const silent = setup([[]]);
    storeLastGood(join(silent.dir, "cache"), makeBuild(), MAIN_SHA);
    expect(await main(["restore"], silent.deps)).toBe(1);
    expect(silent.out).toHaveLength(1);
    expect(silent.out[0]).toMatch(/no boot banner/);
  });
});
