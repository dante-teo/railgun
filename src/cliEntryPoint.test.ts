import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isCliEntryPoint } from "./cliEntryPoint.js";

describe("isCliEntryPoint", () => {
  it("recognizes a direct path as the entry point", () => {
    const path = fileURLToPath(import.meta.url);

    expect(isCliEntryPoint(path, path)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("recognizes a symlink as the entry point", async () => {
    const directory = await mkdtemp(join(tmpdir(), "railgun-entry-point-"));
    const target = join(directory, "cli.js");
    const link = join(directory, "railgun");

    try {
      await writeFile(target, "");
      await symlink(target, link);

      expect(isCliEntryPoint(link, target)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects different files and a missing entry path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "railgun-entry-point-"));
    const entry = join(directory, "entry.js");
    const module = join(directory, "module.js");

    try {
      await Promise.all([writeFile(entry, ""), writeFile(module, "")]);

      expect(isCliEntryPoint(entry, module)).toBe(false);
      expect(isCliEntryPoint(undefined, module)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
