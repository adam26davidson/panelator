// Static facts about the workflows and the image file (spec 106 AC-1, AC-7, AC-8).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const yaml = (p: string) => parse(read(p)) as any;

describe("the image file and the one build script (AC-1)", () => {
  it("holds one line: tag and digest", () => {
    const text = read("firmware/idf-image.txt");
    expect(text).toMatch(/^espressif\/idf:v5\.5\.6@sha256:[0-9a-f]{64}\n$/);
  });
  it("is named by no workflow and no other script", () => {
    const files = [
      ...readdirSync(join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`),
      ...readdirSync(join(root, "firmware/scripts")).map((f) => `firmware/scripts/${f}`),
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(read(f), f).not.toContain("espressif/idf");
  });
  it("is run by build.sh with idf.py, as the calling user, from the image file", () => {
    const sh = read("firmware/scripts/build.sh");
    expect(sh).toContain("idf-image.txt");
    expect(sh).toContain("idf.py");
    expect(sh).toContain("id -u");
    expect(sh).toContain("PANELATOR_COMMIT");
  });
});

describe("ci.yml (AC-7)", () => {
  const ci = yaml(".github/workflows/ci.yml");
  const steps: any[] = ci.jobs.test.steps;
  it("keeps the job, its name and its existing steps in order, on ubuntu-24.04, with no permissions block", () => {
    expect(Object.keys(ci.jobs)).toEqual(["test"]);
    expect(ci.jobs.test["runs-on"]).toBe("ubuntu-24.04");
    expect(ci.jobs.test.permissions).toBeUndefined();
    expect(ci.permissions).toBeUndefined();
    const runs = steps.map((s) => s.run ?? s.uses);
    expect(runs.slice(0, 7)).toEqual([
      "actions/checkout@v4", "pnpm/action-setup@v4", "actions/setup-node@v4", "pnpm install --frozen-lockfile",
      "pnpm -F @panelator/design-stage exec playwright-core install --with-deps chromium", "pnpm test",
      "pnpm -F @panelator/scheduler typecheck",
    ]);
    expect(runs[7]).toBe("pnpm -F @panelator/design-stage lint");
    expect(read("agents/scheduler.yaml")).toMatch(/required_checks:\s*\n?\s*-?\s*\[?\s*"?test"?\s*\]?/);
  });
  it("installs the clang tools, runs the host checks always, and builds only when firmware or workflows changed", () => {
    const text = JSON.stringify(steps);
    expect(text).toContain("clang-format-18");
    expect(text).toContain("clang-tidy-18");
    const host = steps.find((s) => s.run === "firmware/scripts/check-host.sh");
    expect(host).toBeDefined();
    expect(host.if).toBeUndefined();
    const build = steps.find((s) => s.run === "firmware/scripts/build.sh");
    expect(build.if).toContain("steps.firmware_changes.outputs.build == 'true'");
    expect(build.env.PANELATOR_COMMIT).toContain("github.event.pull_request.head.sha");
    const detect = steps.find((s) => s.id === "firmware_changes");
    expect(detect.run).toContain("push");
    expect(detect.run).toContain("firmware/");
    expect(detect.run).toContain(".github/workflows/");
  });
});

describe("hil.yml (AC-8)", () => {
  const wf = yaml(".github/workflows/hil.yml");
  const board = wf.jobs.board;
  it("has the four triggers with their paths", () => {
    const paths = ["firmware/**", "tools/hil/**", ".github/workflows/hil.yml"];
    expect(wf.on.pull_request.paths).toEqual(paths);
    expect(wf.on.push.paths).toEqual(paths);
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.on.schedule).toEqual([{ cron: "17 */6 * * *" }]);
    expect(wf.on.workflow_dispatch.inputs.soak).toMatchObject({ type: "boolean", default: false });
  });
  it("has the concurrency group per pull request or commit, never cancelling", () => {
    expect(wf.concurrency).toEqual({
      group: "hil-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": false,
    });
  });
  it("has two jobs, neither named hil", () => {
    expect(Object.keys(wf.jobs)).toEqual(["build", "board"]);
  });
  it("builds on ubuntu-24.04, not for a soak run, with build.sh and the head commit, and uploads firmware-<sha>", () => {
    const b = wf.jobs.build;
    expect(b["runs-on"]).toBe("ubuntu-24.04");
    expect(b.if).toContain("schedule");
    expect(b.if).toContain("inputs.soak");
    expect(b.env.PANELATOR_COMMIT).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    expect(b.steps[0].with.ref).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    expect(b.steps.some((s: any) => s.run === "firmware/scripts/build.sh")).toBe(true);
    const up = b.steps.find((s: any) => s.uses?.startsWith("actions/upload-artifact"));
    expect(up.with.name).toBe("firmware-${{ github.event.pull_request.head.sha || github.sha }}");
    expect(up.with.path).toContain("firmware/build/flasher_args.json");
    expect(up.with.path).toContain("firmware/build/panelator.bin");
  });
  it("runs the board job on the labelled runner, after build, with the fork rule and its own permissions", () => {
    expect(board["runs-on"]).toEqual(["self-hosted", "panelator-hil"]);
    expect(board.needs).toBe("build");
    expect(board["timeout-minutes"]).toBe(20);
    expect(board.if).toContain("always()");
    expect(board.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(board.permissions).toEqual({ checks: "write", contents: "read", actions: "read" });
  });
  it("starts the check first, completes it on any failure, uploads hil-result, and never installs the whole workspace", () => {
    const steps: any[] = board.steps;
    const runs = steps.map((s) => s.run ?? "");
    const start = runs.findIndex((r) => r.includes("cli.ts start"));
    const run = runs.findIndex((r) => r.includes("cli.ts run"));
    const failed = steps.findIndex((s) => (s.run ?? "").includes("cli.ts complete-failed"));
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(run);
    expect(failed).toBeGreaterThan(run);
    expect(steps[failed].if).toBe("always()");
    const install = runs.find((r) => r.includes("pnpm install"));
    expect(install).toContain("--filter @panelator/hil");
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload.with.name).toBe("hil-result");
    expect(upload.if).toBe("always()");
    expect(JSON.stringify(wf)).not.toContain("PANELATOR_HIL_PORT");
    expect(runs.join("\n")).toContain("--build-failed");
  });
});
