// The check run over the REST API (spec 106 AC-10), with the job's token.
import type { HilResult } from "./result.ts";

export interface CheckApi {
  fetch: typeof fetch;
  apiUrl: string;
  repo: string;
  token: string;
}

async function call(api: CheckApi, method: string, path: string, body: unknown): Promise<{ id: number }> {
  const res = await api.fetch(`${api.apiUrl}/repos/${api.repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { id: number };
}

export async function createCheck(api: CheckApi, name: string, sha: string): Promise<number> {
  const made = await call(api, "POST", "/check-runs", { name, head_sha: sha, status: "in_progress" });
  return made.id;
}

export function summaryOf(result: HilResult): string {
  if (result.tests.length === 0) return result.reason ?? "no tests ran";
  return result.tests.map((t) => `${t.name}: ${t.status}${t.message ? ` (${t.message.replace(/\s+/g, " ")})` : ""}`).join("\n");
}

export async function completeCheck(api: CheckApi, id: number, result: HilResult): Promise<void> {
  await call(api, "PATCH", `/check-runs/${id}`, {
    status: "completed",
    conclusion: result.outcome === "pass" ? "success" : "failure",
    output: { title: `hil: ${result.outcome}`, summary: summaryOf(result), text: JSON.stringify(result) },
  });
}
