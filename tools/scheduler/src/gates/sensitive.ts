import { matchesAny } from "../glob.ts";

export function isSensitive(diffFiles: string[], sensitiveGlobs: string[]): string[] {
  return diffFiles.filter((f) => matchesAny(f, sensitiveGlobs));
}
