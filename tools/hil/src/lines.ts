// The two console lines of the firmware (spec 106 AC-3, AC-4). A later child may add fields at the end of the
// status line, so the status parser tolerates trailing fields.
export interface Banner {
  sha: string;
  idf: string;
  flash_mb: number;
  psram_mb: number;
  reset: string;
}

export interface Status {
  sha: string;
  uptime_s: number;
  resets: number;
  free_heap: number;
  free_psram: number;
}

const BANNER = /^panelator boot sha=(\S+) idf=(\S+) flash_mb=(\d+) psram_mb=(\d+) reset=([a-z_]+)(?:\s.*)?$/;
const STATUS = /^panelator status sha=(\S+) uptime_s=(\d+) resets=(-?\d+) free_heap=(\d+) free_psram=(\d+)(?:\s.*)?$/;

export const BANNER_PATTERN = /panelator boot /;
export const STATUS_PATTERN = /panelator status /;

export function parseBanner(line: string): Banner | null {
  const m = BANNER.exec(line.replace(/\r$/, ""));
  if (!m) return null;
  return { sha: m[1]!, idf: m[2]!, flash_mb: Number(m[3]), psram_mb: Number(m[4]), reset: m[5]! };
}

export function parseStatus(line: string): Status | null {
  const m = STATUS.exec(line.replace(/\r$/, ""));
  if (!m) return null;
  return { sha: m[1]!, uptime_s: Number(m[2]), resets: Number(m[3]), free_heap: Number(m[4]), free_psram: Number(m[5]) };
}
