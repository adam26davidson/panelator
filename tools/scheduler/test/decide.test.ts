import { describe, expect, it } from "vitest";
import { systemOneDecider } from "../src/decide/client.ts";

describe("systemOneDecider", () => {
  it("posts to /v1/systemone with the key and returns typed answers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ answers: { q1: "yes" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const d = systemOneDecider("https://decide.example", "k", fetchFn);
    const r = await d.decide({ state: { stage: "plan" }, questions: [{ id: "q1", text: "proceed?" }] });
    expect(r.answers.q1).toBe("yes");
    expect(calls[0].url).toBe("https://decide.example/v1/systemone");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });
  it("throws on a non-2xx response", async () => {
    const fetchFn = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(systemOneDecider("https://x", "k", fetchFn).decide({ state: {}, questions: [] })).rejects.toThrow(/500/);
  });
});
