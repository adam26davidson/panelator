import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import setup, { PREFIX } from "./helpers/test-tmpdir.ts";
import { repoPair } from "./helpers/repo-pair.ts";

let outer: string;
const saved = process.env.TMPDIR;
beforeEach(() => { outer = mkdtempSync(join(tmpdir(), "outer-")); process.env.TMPDIR = outer; });
afterEach(() => { process.env.TMPDIR = saved; rmSync(outer, { recursive: true, force: true }); });

test("this run's temp files live under the run's own root", () => {
  process.env.TMPDIR = saved;
  expect(basename(tmpdir())).toMatch(new RegExp(`^${PREFIX}`));
});

test("a run's temp files, repo pairs included, are gone after its teardown and TMPDIR is restored", () => {
  const teardown = setup();
  const root = tmpdir();
  expect(dirname(root)).toBe(outer);
  const pair = repoPair();
  expect(existsSync(pair.repo)).toBe(true);
  teardown();
  expect(existsSync(root)).toBe(false);
  expect(process.env.TMPDIR).toBe(outer);
});

test("setup prunes the root of a run killed a day ago but not one still running", () => {
  const killed = join(outer, `${PREFIX}killed`);
  const running = join(outer, `${PREFIX}running`);
  mkdirSync(killed);
  mkdirSync(running);
  const old = new Date(Date.now() - 25 * 3600_000);
  utimesSync(killed, old, old);
  const teardown = setup();
  expect(existsSync(killed)).toBe(false);
  expect(existsSync(running)).toBe(true);
  teardown();
});
