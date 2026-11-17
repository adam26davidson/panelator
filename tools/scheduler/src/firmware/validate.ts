import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { schemaDir, type Validation } from "../schema/validate.ts";
const addFormats = addFormatsModule.default;

export type FirmwareSchemaName = "board-state" | "firmware-release" | "hil-result";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const name of ["board-state", "firmware-release", "hil-result"] as const) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8")), `${name}.json`);
}

export function validate(name: FirmwareSchemaName, data: unknown): Validation {
  const fn = ajv.getSchema(`${name}.json`);
  if (!fn) throw new Error(`unknown schema: ${name}`);
  if (fn(data)) return { ok: true };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${Object.keys(e.params ?? {}).length ? " " + JSON.stringify(e.params) : ""}`.trim());
  return { ok: false, errors };
}
