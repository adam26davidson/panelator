import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The parts of ESP-IDF's flasher_args.json the harness uses. */
export interface FlasherArgs {
  /** offset (hex string) to file path, relative to the build directory */
  flash_files: Record<string, string>;
  flash_settings: { flash_mode: string; flash_size: string; flash_freq: string };
  extra_esptool_args?: { chip?: string; after?: string; before?: string };
}

export function readFlasherArgs(dir: string): FlasherArgs {
  const parsed = JSON.parse(readFileSync(join(dir, "flasher_args.json"), "utf8")) as Partial<FlasherArgs>;
  if (!parsed.flash_files || !parsed.flash_settings) throw new Error(`${dir}/flasher_args.json has no flash_files or flash_settings`);
  return parsed as FlasherArgs;
}
