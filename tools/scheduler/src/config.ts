import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface Config {
  telegram?: {credentials_path:string;long_poll_timeout_s:number};
  repo: string;
  maintainer: string;
  app: { id: number; installation_id: number; private_key_path: string; bot_login: string };
  poll_interval_s: number;
  slots: number;
  liveness_hours: number;
  retry_cost_limit_usd: number;
  /** the strongest model, used for rescue attempts (spec 006 AC-1) */
  rescue_model: string;
  notify_rate_limit_hours: number;
  /** check-run names the verify stage waits on; [] means every check run on the head SHA */
  required_checks: string[];
  state_dir: string;
  labels: {
    priority: string;
    feature_classes: string[];
    debt_classes: string[];
  };
  systemd: { scope: boolean; inhibit: boolean };
  decide: { base_url: string; key_env: string };
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const defaultConfigPath = join(repoRoot, "agents", "scheduler.yaml");
export const agentsDir = join(repoRoot, "agents");

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const num = (k: string, d: number) => {
    const v = raw[k] ?? d;
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`config ${k} must be a number`);
    return v;
  };
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v !== "string" || !v) throw new Error(`config ${k} is required`);
    return v;
  };
  const app = (raw.app ?? {}) as Record<string, unknown>;
  const labels = (raw.labels ?? {}) as Record<string, unknown>;
  const systemd = (raw.systemd ?? {}) as Record<string, unknown>;
  const decide = (raw.decide ?? {}) as Record<string, unknown>;
  const telegram = raw.telegram ?? {};
  if(typeof telegram!=='object'||telegram===null||Array.isArray(telegram))throw new Error('config telegram must be an object');
  const tg=telegram as Record<string,unknown>;
  if(Object.keys(tg).some(k=>!['credentials_path','long_poll_timeout_s'].includes(k)))throw new Error('config telegram unknown key');
  if(tg.credentials_path!==undefined&&(typeof tg.credentials_path!=='string'||!tg.credentials_path))throw new Error('config telegram credentials_path must be a string');
  const timeout=tg.long_poll_timeout_s??50;
  if(typeof timeout!=='number'||!Number.isFinite(timeout)||timeout<1)throw new Error('config telegram long_poll_timeout_s must be >= 1');
  const cfg: Config = {
    telegram:{credentials_path:expandHome(String(tg.credentials_path??'~/.config/panelator/telegram.json')),long_poll_timeout_s:timeout},
    repo: str("repo"),
    maintainer: str("maintainer"),
    app: {
      id: Number(app.id ?? 0),
      installation_id: Number(app.installation_id ?? 0),
      private_key_path: expandHome(String(app.private_key_path ?? "~/.config/panelator/scheduler-app.pem")),
      bot_login: String(app.bot_login ?? ""),
    },
    poll_interval_s: num("poll_interval_s", 45),
    slots: num("slots", 1),
    liveness_hours: num("liveness_hours", 2),
    retry_cost_limit_usd: num("retry_cost_limit_usd", 1),
    rescue_model: typeof raw.rescue_model === "string" && raw.rescue_model ? raw.rescue_model : "claude-fable-5-1",
    notify_rate_limit_hours: num("notify_rate_limit_hours", 4),
    required_checks: Array.isArray(raw.required_checks) ? (raw.required_checks as string[]) : [],
    state_dir: expandHome(String(raw.state_dir ?? "~/.local/state/panelator-scheduler")),
    labels: {
      priority: String(labels.priority ?? "priority"),
      feature_classes: (labels.feature_classes as string[]) ?? ["class:product"],
      debt_classes: (labels.debt_classes as string[]) ?? ["class:bug", "class:tooling", "class:dependency"],
    },
    systemd: { scope: systemd.scope !== false, inhibit: systemd.inhibit !== false },
    decide: { base_url: String(decide.base_url ?? ""), key_env: String(decide.key_env ?? "PANELATOR_DECIDE_KEY") },
  };
  if (cfg.slots < 1) throw new Error("config slots must be >= 1");
  if (cfg.poll_interval_s < 5) throw new Error("config poll_interval_s must be >= 5");
  if (!cfg.app.bot_login) throw new Error("config app.bot_login is required");
  return cfg;
}
