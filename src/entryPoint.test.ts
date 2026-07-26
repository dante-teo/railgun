import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isEntryPoint } from "./entryPoint.js";

describe("isEntryPoint", () => {
  it("recognizes a module invoked directly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "railgun-entry-point-"));
    try {
      const path = join(directory, "backend.js");
      await writeFile(path, "");
      expect(isEntryPoint(path, path)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes a symlinked entry point", async () => {
    const directory = await mkdtemp(join(tmpdir(), "railgun-entry-point-"));
    try {
      const target = join(directory, "backend.js");
      const link = join(directory, "railgun-backend");
      await writeFile(target, "");
      await symlink(target, link);
      expect(isEntryPoint(link, await realpath(target))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing and different entry paths", () => {
    expect(isEntryPoint(undefined, "/missing/backend.js")).toBe(false);
    expect(isEntryPoint("/missing/entry.js", "/missing/backend.js")).toBe(false);
  });
});
