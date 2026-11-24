import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORTS, IMPORT_MODULE, IMPORTS, sigText } from "./abi.ts";

const doc = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "widget-abi.md"), "utf8");

describe("the import table", () => {
  it("equals the names and signatures of docs/widget-abi.md", () => {
    const table = doc.split("\n## Imports")[1]?.split("\n## ")[0] ?? "";
    const rows = table.split("\n").filter((l) => l.startsWith("| `panelator`"));
    expect(rows).toHaveLength(16);
    const fromDoc: Record<string, string> = {};
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const types = [...(cells[3] ?? "").matchAll(/:\s*(i32|i64)/g)].map((m) => m[1]);
      const result = (cells[4] ?? "").replaceAll("`", "");
      fromDoc[(cells[2] ?? "").replaceAll("`", "")] = `(${types.join(", ")})${result ? ` -> ${result}` : ""}`;
    }
    expect(Object.fromEntries(Object.entries(IMPORTS).map(([k, v]) => [k, sigText(v)]))).toEqual(fromDoc);
    expect(IMPORT_MODULE).toBe("panelator");
  });
  it("the exports are the document's six", () => {
    const rows = (doc.split("## Exports")[1]?.split("\n## ")[0] ?? "")
      .split("\n")
      .filter((l) => l.startsWith("| `pn_"));
    expect(rows.map((r) => r.split("|")[1]?.replaceAll("`", "").trim()).sort()).toEqual(Object.keys(EXPORTS).sort());
  });
});
