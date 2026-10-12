#!/usr/bin/env node
// git credential helper: answers github.com with the App installation token from token.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const op = process.argv[2];
const input = readFileSync(0, "utf8");
const fields = Object.fromEntries(input.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]));
if (op === "get" && fields.host === "github.com") {
  const stateDir = process.env.PANELATOR_STATE_DIR;
  if (stateDir) {
    try {
      const t = JSON.parse(readFileSync(join(stateDir, "token.json"), "utf8")) as { token?: string };
      if (t.token) process.stdout.write(`username=x-access-token\npassword=${t.token}\n`);
    } catch {
      /* no token: say nothing, git falls through to other helpers */
    }
  }
}
