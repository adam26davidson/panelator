import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Profile } from "../types.ts";

export function listProfiles(agentsDir: string): string[] {
  return readdirSync(join(agentsDir, "profiles"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function resolveProfile(agentsDir: string, name: string): Profile {
  const dir = join(agentsDir, "profiles", name);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !existsSync(join(dir, "profile.yaml"))) throw new Error(`unknown profile: ${name}`);
  const y = parse(readFileSync(join(dir, "profile.yaml"), "utf8")) as Record<string, unknown>;
  const tools = Array.isArray(y.tools) ? (y.tools as string[]) : [];
  const criteriaFile = typeof y.review_criteria === "string" ? y.review_criteria : null;
  return {
    name,
    dir,
    skillsDir: join(dir, "skills"),
    instructions: existsSync(join(dir, "instructions.md")) ? readFileSync(join(dir, "instructions.md"), "utf8") : "",
    tools,
    credentialHook: typeof y.credential_hook === "string" ? y.credential_hook : undefined,
    reviewCriteria: criteriaFile ? readFileSync(join(dir, criteriaFile), "utf8") : undefined,
  };
}

export function readSensitiveGlobs(agentsDir: string): string[] {
  return readFileSync(join(agentsDir, "sensitive-paths.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
