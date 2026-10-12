import { join } from "node:path";

/** Environment every stage gets so gh and git authenticate as the App without seeing the token (spec section 12). */
export function stageEnv(binDir: string, stateDir: string, identity?: { name: string; email: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PANELATOR_STATE_DIR: stateDir,
    // an empty credential.helper first clears every helper collected from system/global
    // config (URL-scoped ones included), so the App helper is the only one git asks
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: join(binDir, "git-credential-panelator.ts"),
    // No SSH route to a remote and no ambient token from the scheduler's own environment;
    // the gh shim re-exports GH_TOKEN from token.json, so gh still authenticates as the App.
    GIT_SSH_COMMAND: "/bin/false",
    SSH_AUTH_SOCK: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
  if (identity) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return env;
}
