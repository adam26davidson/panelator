import { matchesAny } from "../glob.ts";

/** Spec 070 AC-1: a firmware PR is one whose files include a path matching one of `firmware.paths`. */
export const isFirmwarePr = (files: string[], globs: string[]): boolean => files.some((f) => matchesAny(f, globs));

/** The literal directory prefix of a glob: `firmware/**` is `firmware/`. */
const prefix = (glob: string): string => glob.split("*")[0]!;

/** Spec 070 AC-5: whether a spec's listed interface paths name a path under a firmware prefix. */
export function specNamesFirmwarePath(listedPaths: string[], globs: string[]): boolean {
  return listedPaths.some((p) => globs.some((g) => (prefix(g) ? p.startsWith(prefix(g)) : matchesAny(p, [g]))));
}
