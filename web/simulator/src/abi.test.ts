import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORT_TABLE, IMPORT_TABLE } from "./abi.ts";
import { root } from "./files.ts";

const doc = readFileSync(join(root, "docs", "widget-abi.md"), "utf8");

const types = (cell: string): string[] => [...cell.matchAll(/(\w+): (i32|i64)/g)].map((m) => m[2] as string);

describe("the import table", () => {
  it("equals the names and signatures of docs/widget-abi.md", () => {
    const table: Record<string, { params: string[]; results: string[] }> = {};
    for (const line of doc.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells[1] !== "`panelator`") continue;
      table[(cells[2] as string).replaceAll("`", "")] = {
        params: types(cells[3] as string),
        results: (cells[4] as string).includes("`i64`") ? ["i64"] : (cells[4] as string).includes("`i32`") ? ["i32"] : [],
      };
    }
    expect(Object.keys(table)).toHaveLength(16);
    expect(IMPORT_TABLE).toEqual(JSON.parse(JSON.stringify(table)));
  });

  it("the exports are the document's six", () => {
    expect(Object.keys(EXPORT_TABLE)).toEqual(["pn_abi_version", "pn_update_hz", "pn_width", "pn_height", "pn_init", "pn_update"]);
    for (const name of Object.keys(EXPORT_TABLE)) expect(doc).toContain(`\`${name}\``);
  });
});
