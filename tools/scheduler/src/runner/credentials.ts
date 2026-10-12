import { join } from "node:path";

/** Environment every stage gets so gh and git authenticate as the App without seeing the token (spec section 12). */
export function stageEnv(binDir: string, stateDir: string): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PANELATOR_STATE_DIR: stateDir,
    // an empty credential.helper first clears every helper collected from system/global
    // config (URL-scoped ones included), so the App helper is the only one git asks
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: join(binDir, "git-credential-panelator.ts"),
  };
}
