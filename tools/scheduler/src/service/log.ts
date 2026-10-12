import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class ServiceLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  write(rec: Record<string, unknown>): void {
    appendFileSync(this.path, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
  }
  tick(info: Record<string, unknown>): void {
    this.write({ kind: "tick", ...info });
  }
  stopped(reason: string): void {
    this.write({ kind: "stopped", reason });
  }
}
