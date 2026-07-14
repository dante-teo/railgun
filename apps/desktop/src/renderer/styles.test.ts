import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop activity styles", () => {
  it("stacks portalled selects above dialogs", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain("--layer-dialog-popover: 62");
    expect(css).toMatch(/\.ui-select-content\s*\{[^}]*z-index:\s*var\(--layer-dialog-popover\)/u);
  });

  it("retains the failed-run danger presentation", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.run-error\s*\{[^}]*var\(--color-danger\)[^}]*\}/u);
  });
});
