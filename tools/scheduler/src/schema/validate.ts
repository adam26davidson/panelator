import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default;

export type SchemaName =
  | "plan-result"
  | "implement-result"
  | "review-result"
  | "fix-result"
  | "finding"
  | "usage-record"
  | "claim"
  | "stage-input"
  | "question"
  | "spec-result"
  | "question-check-result"
  | "paused"
  | "escalation-ledger"
  | "question-log-entry"
  | "standing-definition" | "standing-result" | "action" | "action-log-entry"
  | "parameter-definition" | "parameters" | "filer-result" | "triage-entry" | "agent-state" | "filer-input" | "audit-input"
  | "event" | "metric-definition" | "metrics-report" | "reflection-input" | "reflection-result" | "reflection-plan";

const NAMES: SchemaName[] = [
  "standing-definition", "standing-result", "action", "action-log-entry", "parameter-definition", "parameters", "filer-result", "triage-entry", "agent-state", "filer-input", "audit-input",
  "metrics-report", "event", "metric-definition", "reflection-plan", "reflection-input", "reflection-result",
  "finding",
  "plan-result",
  "implement-result",
  "review-result",
  "fix-result",
  "usage-record",
  "claim",
  "stage-input",
  "question",
  "spec-result",
  "question-check-result",
  "paused",
  "escalation-ledger",
  "question-log-entry",
];

export const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "schemas", "scheduler");

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const name of NAMES) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8")), `${name}.json`);
}

export type Validation = { ok: true } | { ok: false; errors: string[] };

export function validate(name: SchemaName, data: unknown): Validation {
  const fn = ajv.getSchema(`${name}.json`);
  if (!fn) throw new Error(`unknown schema: ${name}`);
  if (fn(data)) return { ok: true };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${Object.keys(e.params ?? {}).length ? " " + JSON.stringify(e.params) : ""}`.trim());
  return { ok: false, errors };
}
