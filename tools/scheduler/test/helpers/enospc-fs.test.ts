import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEnospc, type EnospcSwitch } from "./enospc-fs.mjs";

let sw: EnospcSwitch | undefined;
afterEach(() => sw?.restore());

describe("enospc-fs", () => {
  it("fails writes under the root only, while the switch is on", async () => {
    const root = mkdtempSync(join(tmpdir(), "panelator-test-enospc-"));
    const other = mkdtempSync(join(tmpdir(), "panelator-test-other-"));
    writeFileSync(join(root, "a"), "x");
    sw = installEnospc(root);
    await expect(appendFile(join(root, "a"), "y")).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(writeFile(join(root, "b"), "y")).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(mkdir(join(root, "new"))).rejects.toMatchObject({ code: "ENOSPC" });
    expect(() => appendFileSync(join(root, "a"), "y")).toThrow(/ENOSPC/);
    expect(() => mkdirSync(join(root, "newer"))).toThrow(/ENOSPC/);
    const h = await open(join(root, "lock"), "wx");
    await expect(h.writeFile("1")).rejects.toMatchObject({ code: "ENOSPC" });
    await h.close();
    await writeFile(join(other, "c"), "ok");
    expect(await readFile(join(root, "a"), "utf8")).toBe("x");
    await mkdir(root, { recursive: true });
    sw.on = false;
    await appendFile(join(root, "a"), "y");
    expect(readFileSync(join(root, "a"), "utf8")).toBe("xy");
  });
});
