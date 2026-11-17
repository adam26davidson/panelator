import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export class SleepInhibitor {
  #enabled: boolean;
  #bin: string;
  #spawn: typeof nodeSpawn;
  #log: (rec: Record<string, unknown>) => void;
  #child: ChildProcess | null = null;
  #unavailableLogged = false;
  #started = false;

  constructor(opts: { enabled: boolean; bin?: string; spawn?: typeof nodeSpawn; log?: (rec: Record<string, unknown>) => void }) {
    this.#enabled = opts.enabled;
    this.#bin = opts.bin ?? "systemd-inhibit";
    this.#spawn = opts.spawn ?? nodeSpawn;
    this.#log = opts.log ?? (() => {});
  }

  get held(): boolean {
    return this.#child !== null;
  }

  /** `why` names the run that took the lock; later runs share it until the last one ends. */
  acquire(why = "stage in flight"): void {
    if (!this.#enabled || this.#child) return;
    let child: ChildProcess;
    try {
      child = this.#spawn(this.#bin, ["--what=sleep:idle", "--who=panelator-scheduler", `--why=${why}`, "--mode=block", "sleep", "infinity"], { stdio: "ignore" });
    } catch (e) {
      this.#unavailable((e as Error).message);
      return;
    }
    this.#child = child;
    this.#started = false;
    // Logged on spawn, not here: a missing binary only reports ENOENT on a later turn, and no lock was taken.
    child.on("spawn", () => {
      if (this.#child !== child) return;
      this.#started = true;
      this.#log({ kind: "inhibit-acquired", why });
    });
    // Exit or error while still held: the lock was never taken or was lost (no binary, logind refused it).
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#unavailable(`exited ${code ?? signal}`);
    });
    child.on("error", (e) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#unavailable((e as Error).message);
    });
    child.unref();
  }

  release(): void {
    const c = this.#child;
    this.#child = null;
    if (!c) return;
    c.kill();
    if (this.#started) this.#log({ kind: "inhibit-released" });
  }

  #unavailable(error: string): void {
    console.error(`sleep inhibitor unavailable: ${error}`);
    if (this.#unavailableLogged) return;
    this.#unavailableLogged = true;
    this.#log({ kind: "inhibit-unavailable", error });
  }
}
