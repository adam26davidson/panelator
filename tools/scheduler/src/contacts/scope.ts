import type { AppClient } from "../github/auth.ts";

export type ScopeResult = { status: "ok" } | { status: "failed"; reason: string };

/** Spec 099 AC-11 (ADR 0014): the installation reaches the configured repository and no other. */
export async function checkInstallationScope(ctx: { app: Pick<AppClient, "appInstallations" | "installationRepositories">; installationId: number; repo: string }): Promise<ScopeResult> {
  const installations = await ctx.app.appInstallations();
  const problems: string[] = [];
  const mine = installations.find((i) => i.id === ctx.installationId);
  const others = installations.filter((i) => i.id !== ctx.installationId);
  if (!mine) problems.push(`installation ${ctx.installationId} is not among the App's installations`);
  if (others.length) problems.push(`the App has other installations: ${others.map((i) => i.id).join(", ")}`);
  if (mine && mine.repository_selection !== "selected") problems.push(`repository_selection is ${mine.repository_selection} (all repositories)`);
  if (mine && mine.repository_selection === "selected") {
    const repos = await ctx.app.installationRepositories();
    const extra = repos.filter((r) => r !== ctx.repo);
    if (extra.length) problems.push(`the installation also reaches ${extra.join(", ")}`);
    if (!repos.includes(ctx.repo)) problems.push(`the installation does not list ${ctx.repo}`);
  }
  return problems.length ? { status: "failed", reason: problems.join("; ") } : { status: "ok" };
}

export const SCOPE_FIX = "open the App's installation settings and set Only select repositories to adam26davidson/panelator";
