import { describe, expect, it } from "vitest";
import { validate } from "../../tools/scheduler/src/schema/validate.ts";
import { emptySnapshot, snapshot } from "./fixtures.ts";

// The app's types follow schemas/scheduler/console-state.json; the fixtures every screen test renders must satisfy it.
describe("fixture snapshots", () => {
  it("are valid console-state documents", () => {
    expect(validate("console-state", snapshot)).toEqual({ ok: true });
    expect(validate("console-state", emptySnapshot)).toEqual({ ok: true });
  });
});
