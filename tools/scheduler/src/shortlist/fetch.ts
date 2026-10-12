import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import type { SelectContext } from "./select.ts";

function gitShow(repoDir: string, ref: string): string | null {
  try {
    return execFileSync("git", ["show", ref], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Specs and design artifacts are read from origin/main, never from the working tree (spec section 8, "on main"). */
export function buildSelectContext(repoDir: string, cfg: Config, claimed: Set<number>, botLogin: string): SelectContext {
  return {
    appBot: botLogin,
    maintainer: cfg.maintainer,
    labels: cfg.labels,
    claimed,
    readSpec: (path) => gitShow(repoDir, `origin/main:${path}`),
    listDesign: (specPath) => {
      try {
        const out = execFileSync("git", ["ls-tree", "--name-only", `origin/main:${dirname(specPath)}/design`], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
