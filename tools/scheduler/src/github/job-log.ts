const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

/** A job log as the fix stage and the history should read it: no colour codes, no timestamps, no blank lines, nothing after the last `##[error]` line, the last `lines` lines. */
export function cleanJobLog(raw: string, lines: number): string {
  const cleaned = raw
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(CSI, "").replace(TIMESTAMP, ""))
    .filter((l) => l.trim().length > 0);
  let end = cleaned.length;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i].startsWith("##[error]")) {
      end = i + 1;
      break;
    }
  }
  return cleaned.slice(Math.max(0, end - lines), end).join("\n");
}
