import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_KINDS } from "../src/events/kinds.ts";
import { validate } from "../src/schema/validate.ts";
import { E2E_FILES, recordedWorlds } from "./helpers/e2e-chain.ts";

// Runs in vitest.config.ts's "after" group, once every e2e-N.test.ts file has finished and recorded its worlds
// (helpers/e2e-chain.ts recordWorlds). Run alone it fails: there are no recorded chains to read.

describe("every event kind is recorded across the recorded chains (spec 026 AC-2)", () => {
  /** Every kind has a producer now: spec 027 added `metrics.snapshot`, spec 028 `reflection.plan`. */
  const NOT_YET_PRODUCED: string[] = [];
  /** The AWS kinds (spec 022) are produced only with an `aws` block, and are asserted in aws.test.ts; the F2 contact kinds are not asserted either. */
  const RESERVED = ["aws.cost", "aws.reserve"];
  it("finds each kind at least once in the events/ files the runs above left", () => {
    const recorded = recordedWorlds();
    expect(Object.keys(recorded).sort()).toEqual([...E2E_FILES].sort());
    const worldPaths = Object.values(recorded).flat();
    expect(worldPaths.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    const contacts = new Set<string>();
    for (const p of worldPaths) {
      if (!existsSync(p.events)) continue;
      for (const f of readdirSync(p.events).filter((f) => f.endsWith(".jsonl"))) {
        for (const l of readFileSync(join(p.events, f), "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(l);
          expect(validate("event", e), l).toEqual({ ok: true });
          seen.add(e.kind);
          if (e.kind === "maintainer.contact") contacts.add(e.payload.kind);
        }
      }
    }
    expect(EVENT_KINDS.filter((k) => !seen.has(k) && !RESERVED.includes(k) && !NOT_YET_PRODUCED.includes(k))).toEqual([]);
    for (const k of ["notification", "question", "reminder"]) expect(contacts.has(k), k).toBe(true);
  });
});
