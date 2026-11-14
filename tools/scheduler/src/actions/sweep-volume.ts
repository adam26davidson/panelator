import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedVolumes, staleLeftovers, walkCount, type Leftover, type SweepAge } from "../service/sweep.ts";
import { commitsPatch, pruneWorktrees, remoteBase, removeWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { exact, type ActionContext, type ActionKind } from "./index.ts";

const AGES: string[] = ["stale", "urgent"];

/** Spec 064 AC-3: the work of a worktree about to go, saved; null when there is none. */
async function saveWork(c: ActionContext, l: Leftover): Promise<string | null> {
  if (!existsSync(join(l.path, ".git"))) return null;
  const base = await remoteBase(l.path);
  const text = [await uncommittedPatch(l.path), await commitsPatch(l.path, base)].filter(Boolean).join("\n");
  if (!text) return null;
  await mkdir(c.paths.patchesSweep, { recursive: true });
  const file = join(c.paths.patchesSweep, `${l.name}-${c.now().toISOString().replace(/[:.]/g, "-")}.patch`);
  await writeFile(file, text);
  return file;
}

export const sweepVolumeKind: ActionKind = {
  changesMode: false,
  async check(a, c) {
    exact(a, ["path", "age"]);
    if (typeof a.path !== "string" || !checkedVolumes(c.paths).includes(a.path)) return "path is not a checked volume";
    if (typeof a.age !== "string" || !AGES.includes(a.age)) return "age must be stale or urgent";
    return null;
  },
  async apply(a, c) {
    const path = String(a.path), age = a.age as SweepAge;
    if (!c.repoDir) throw new Error("sweep_volume needs the repository directory");
    const removed: string[] = [], patches: string[] = [], failed: string[] = [];
    let freed = 0, prune = false;
    for (const l of await staleLeftovers(path, age, { paths: c.paths, repoDir: c.repoDir, now: c.now, activeIssues: c.activeIssues })) {
      try {
        if (l.kind === "missing-worktree") prune = true;
        else {
          freed += (await walkCount(l.path, { left: Infinity })).count;
          if (l.kind === "test-root") await rm(l.path, { recursive: true, force: true });
          else {
            const patch = await saveWork(c, l);
            if (patch) patches.push(patch);
            try {
              await removeWorktree(c.repoDir, l.path);
            } catch {
              // not registered with git: a leftover directory, the work of which is already saved above
              await rm(l.path, { recursive: true, force: true });
              prune = true;
            }
          }
        }
        removed.push(l.name);
      } catch (e) {
        failed.push(`${l.name}: ${(e as Error).message}`);
      }
    }
    if (prune) await pruneWorktrees(c.repoDir).catch((e) => failed.push(`prune: ${(e as Error).message}`));
    c.onSweep?.({ removed, freed_inodes: freed, patches });
    c.serviceLog?.({ kind: "disk-sweep", path, age, agent: c.actor, removed, freed_inodes: freed, patches, ...(failed.length ? { failed } : {}) });
    if (failed.length) throw new Error(`could not remove ${failed.join("; ")}`);
    return { undo: null };
  },
};
