import { execFile } from "node:child_process";
import type { AwsConfig } from "../config.ts";

/** Spec 022 AC-1: the one place `aws` is spawned. The credential stays the CLI's; nothing of it is read here. */
export interface AwsCli {
  /** Runs `aws <args> --profile <p> --region <r> --output json` and parses its output. */
  run(args: string[]): Promise<unknown>;
}

export interface AwsCliOptions {
  /** The command path; tests pass a fake. */
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Keeps a key, token or secret a failing command printed out of any log line. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/((?:secret|token|key|password|session)[\w-]*["']?\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

export function awsCli(cfg: Pick<AwsConfig, "profile" | "region">, opts: AwsCliOptions = {}): AwsCli {
  const command = opts.command ?? "aws";
  const timeout = opts.timeoutMs ?? 60_000;
  return {
    run(args) {
      const full = [...args, "--profile", cfg.profile, "--region", cfg.region, "--output", "json"];
      return new Promise((resolve, reject) => {
        execFile(command, full, { timeout, env: opts.env ?? process.env, maxBuffer: 8 * 2 ** 20 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${redact(String(stderr || err.message)).trim().slice(0, 300)}`));
          try {
            resolve(stdout.trim() ? JSON.parse(stdout) : {});
          } catch {
            reject(new Error(`aws ${args.slice(0, 2).join(" ")} printed output that is not JSON`));
          }
        });
      });
    },
  };
}
