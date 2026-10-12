import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export class SleepInhibitor {
  #enabled: boolean;
  #bin: string;
  #spawn: typeof nodeSpawn;
  #child: ChildProcess | null = null;

  constructor(opts: { enabled: boolean; bin?: string; spawn?: typeof nodeSpawn }) {
    this.#enabled = opts.enabled;
    this.#bin = opts.bin ?? "systemd-inhibit";
    this.#spawn = opts.spawn ?? nodeSpawn;
  }

  get held(): boolean {
    return this.#child !== null;
  }

  acquire(): void {
    if (!this.#enabled || this.#child) return;
    const child = this.#spawn(this.#bin, ["--what=sleep:idle", "--who=panelator-scheduler", "--why=stage in flight", "--mode=block", "sleep", "infinity"], { stdio: "ignore" });
    child.on("exit", () => {
      if (this.#child === child) this.#child = null;
    });
    child.unref();
    this.#child = child;
  }

  release(): void {
    const c = this.#child;
    this.#child = null;
    c?.kill();
  }
}
