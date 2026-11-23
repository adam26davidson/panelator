// The board as a test sees it: the lines read so far, and a wait for the next matching line.
import type { BoardConfig } from "./config.ts";
import type { Clock } from "./lock.ts";
import type { SerialSession } from "./serial.ts";

export interface Board {
  /** The commit under test. */
  commit: string;
  config: BoardConfig;
  /** Every line read so far. */
  lines(): readonly string[];
  /** The first line matching `pattern` that arrives (or was read but not yet consumed) within `timeoutMs`, else null. */
  waitForLine(pattern: RegExp, timeoutMs: number): Promise<string | null>;
}

export class Log {
  private parts: string[] = [];
  add(text: string): void {
    for (const line of text.replace(/\r/g, "").split("\n")) if (line !== "") this.parts.push(line);
  }
  text(): string {
    return this.parts.length ? `${this.parts.join("\n")}\n` : "";
  }
}

export class LiveBoard implements Board {
  private read: string[] = [];
  private cursor = 0;
  private session: SerialSession;
  private clock: Clock;
  private log: Log;
  readonly commit: string;
  readonly config: BoardConfig;

  constructor(session: SerialSession, clock: Clock, log: Log, commit: string, config: BoardConfig) {
    this.session = session;
    this.clock = clock;
    this.log = log;
    this.commit = commit;
    this.config = config;
  }

  lines(): readonly string[] {
    return this.read;
  }

  async waitForLine(pattern: RegExp, timeoutMs: number): Promise<string | null> {
    const deadline = this.clock.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.read.length) {
        const line = this.read[this.cursor++]!;
        if (pattern.test(line)) return line;
      }
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) return null;
      const line = await this.session.nextLine(remaining);
      if (line === null) return null;
      const clean = line.replace(/\r?\n$/, "").replace(/\r$/, "");
      this.read.push(clean);
      this.log.add(clean);
    }
  }
}
