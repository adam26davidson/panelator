import { describe, expect, it } from "vitest";
import { watchTickErrors } from "./helpers/tick-errors.ts";

const stub = (...results: string[][]) => {
  const outs = results.map((errors) => ({ errors }));
  let i = 0;
  return { outs, tick: async () => outs[i++]! };
};

describe("watchTickErrors (spec 081 AC-5)", () => {
  it("(a) reports an unallowed error once per tick and check() names it", async () => {
    const t = stub(["main checks: boom"], ["main checks: boom"]);
    const w = watchTickErrors(t);
    await t.tick(); await t.tick();
    expect(w.unexpected()).toEqual(["main checks: boom", "main checks: boom"]);
    expect(() => w.check()).toThrow(/^unexpected tick errors:[\s\S]*main checks: boom/);
  });
  it("(b) an allowed pattern covers errors before and after the allow call", async () => {
    const t = stub(["main checks: boom"], ["main checks: again"]);
    const w = watchTickErrors(t);
    await t.tick();
    w.allow(/^main checks: /);
    await t.tick();
    expect(w.unexpected()).toEqual([]);
    expect(() => w.check()).not.toThrow();
  });
  it("(c) an allowed pattern does not hide a different error", async () => {
    const t = stub(["sweep: x"]);
    const w = watchTickErrors(t);
    w.allow(/^main checks: /);
    await t.tick();
    expect(w.unexpected()).toEqual(["sweep: x"]);
  });
  it("(d) a clean tick records nothing and its result is returned unchanged", async () => {
    const t = stub([]);
    const w = watchTickErrors(t);
    expect(await t.tick()).toBe(t.outs[0]);
    expect(w.unexpected()).toEqual([]);
    expect(() => w.check()).not.toThrow();
  });
});
