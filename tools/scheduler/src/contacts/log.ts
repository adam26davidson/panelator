import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";

/** Spec 083 AC-3: the two shapes of a contacts log line. */
export type ContactLogLine =
  | { at: string; event: "refused"; actor: string; run_id: string | null; party: string; command: string[] }
  | {
      at: string; event: "removed"; actor: "maintainer"; party: string;
      entry: { party: string; channel: string; approved_at: string; question_comment_id: number | string | null; issue: number | null };
    };

/** The one writer of contacts/log.jsonl. Throws, writing nothing, on a line that fails the schema. */
export async function appendContactLog(paths: StatePaths, line: ContactLogLine): Promise<void> {
  const v = validate("contacts-log-entry", line);
  if (!v.ok) throw new Error(`invalid contacts log entry: ${v.errors.join("; ")}`);
  await mkdir(dirname(paths.contactsLog), { recursive: true });
  await appendFile(paths.contactsLog, JSON.stringify(line) + "\n");
}

export async function readContactLog(paths: StatePaths, since?: string): Promise<ContactLogLine[]> {
  let text: string;
  try {
    text = await readFile(paths.contactsLog, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ContactLogLine).filter((l) => !since || l.at >= since);
}

const CONTENT_FLAGS = new Set(["--body", "-b", "--body-file", "--title", "-t", "--field", "-f", "--raw-field", "-F", "--input"]);

/** Spec 083 AC-1: argv after `gh` with the value of every content-carrying flag replaced by `<omitted>`. */
export function redactCommand(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0 && CONTENT_FLAGS.has(a.slice(0, eq))) out.push(`${a.slice(0, eq)}=<omitted>`);
    else if (CONTENT_FLAGS.has(a) && i + 1 < argv.length) {
      out.push(a, "<omitted>");
      i++;
    } else out.push(a);
  }
  return out;
}
