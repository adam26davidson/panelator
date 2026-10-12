import { spawn } from "node:child_process";

export interface SpawnOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  onStdoutChunk: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  graceMs?: number;
  scope?: { enabled: boolean; unitName: string; systemdRunBin?: string };
  killOnEvent?: () => boolean;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killedByEvent: boolean;
  pgid: number;
  wallMs: number;
}

export function scopeArgv(argv: string[], unitName: string, bin = "systemd-run"): string[] {
  return [bin, "--user", "--scope", "--quiet", "--unit", unitName, "-p", "MemoryMax=50%", "-p", "OOMPolicy=continue", "-p", "KillMode=control-group", "--", ...argv];
}

export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already gone */
  }
}

async function waitGroupGone(pgid: number, maxMs: number): Promise<void> {
  const start = Date.now();
  while (isProcessGroupAlive(pgid) && Date.now() - start < maxMs) await new Promise((r) => setTimeout(r, 200));
}

export function spawnBounded(o: SpawnOptions): Promise<SpawnResult> {
  const argv = o.scope?.enabled ? scopeArgv(o.argv, o.scope.unitName, o.scope.systemdRunBin) : o.argv;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid!;
    let timedOut = false;
    let killedByEvent = false;
    let killing = false;
    let killTimer: NodeJS.Timeout | undefined;
    const grace = o.graceMs ?? 10_000;

    const kill = (why: "timeout" | "event") => {
      if (killing) return;
      killing = true;
      if (why === "timeout") timedOut = true;
      else killedByEvent = true;
      killGroup(pgid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pgid, "SIGKILL"), grace);
      killTimer.unref();
    };

    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      o.onStdoutChunk(c);
      if (o.killOnEvent?.()) kill("event");
    });
    child.stderr.on("data", (c: Buffer) => o.onStderrChunk?.(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (killing || isProcessGroupAlive(pgid)) {
        killGroup(pgid, "SIGKILL");
        await waitGroupGone(pgid, 30_000);
      }
      resolve({ exitCode, signal, timedOut, killedByEvent, pgid, wallMs: Date.now() - started });
    });
  });
}
