import { readFileSync } from "node:fs";

export interface BoardConfig {
  expected: { flash_mb: number; psram_mb: number };
  port_prefixes: string[];
  timeouts_s: { banner: number; status: number; soak: number; lock: number; download_mode: number; flash: number };
}

export function loadConfig(path = new URL("../board.json", import.meta.url)): BoardConfig {
  return JSON.parse(readFileSync(path, "utf8")) as BoardConfig;
}
