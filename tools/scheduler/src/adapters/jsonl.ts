import { createReadStream } from "node:fs";

/** Strict LF framing (pi json.md): never use readline, which also splits on U+2028/U+2029. */
export class JsonlSplitter {
  #buf = "";
  #malformed: string[] = [];

  push(chunk: Buffer | string): unknown[] {
    this.#buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) >= 0) {
      let line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      const parsed = this.#parse(line);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  end(): { records: unknown[]; malformed: string[] } {
    const records: unknown[] = [];
    const tail = this.#buf.trim();
    this.#buf = "";
    if (tail) {
      const parsed = this.#parse(tail);
      if (parsed !== undefined) records.push(parsed);
    }
    const malformed = this.#malformed;
    this.#malformed = [];
    return { records, malformed };
  }

  #parse(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      this.#malformed.push(line);
      return undefined;
    }
  }
}

export async function readJsonlFile(path: string): Promise<{ records: unknown[]; malformed: string[] }> {
  const s = new JsonlSplitter();
  const records: unknown[] = [];
  for await (const chunk of createReadStream(path)) records.push(...s.push(chunk as Buffer));
  const tail = s.end();
  return { records: [...records, ...tail.records], malformed: tail.malformed };
}
