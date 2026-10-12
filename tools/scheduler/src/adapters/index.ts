import type { Harness } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { piAdapter } from "./pi.ts";
import type { Adapter } from "./types.ts";

export function adapterFor(harness: Harness, fake?: Adapter): Adapter {
  if (harness === "claude") return claudeAdapter;
  if (harness === "pi") return piAdapter;
  if (fake) return fake;
  throw new Error("fake adapter requested but none supplied");
}

export { claudeAdapter, piAdapter };
export type { Adapter } from "./types.ts";
