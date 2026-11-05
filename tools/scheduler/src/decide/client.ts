import type { DecideRequest, DecideResponse, Decider } from "./types.ts";

/** Seam for a decision model (spec section 1, 15). No caller in v0. */
export function systemOneDecider(baseUrl: string, key: string, fetchFn: typeof fetch = fetch): Decider {
  return {
    async decide(req: DecideRequest): Promise<DecideResponse> {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`decide: HTTP ${res.status}`);
      const body = (await res.json()) as DecideResponse;
      if (!body || typeof body.answers !== "object") throw new Error("decide: malformed response");
      return body;
    },
  };
}
