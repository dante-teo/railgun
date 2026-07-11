import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./listDirectory.js";

const context: ToolContext = {
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => {
    throw new Error("list_directory must not request shell approval");
  }
};

describe("list_directory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-listdir-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists files and subdirectories, sorted, with subdirectories suffixed with /", async () => {
    await writeFile(join(dir, "b.txt"), "b", "utf-8");
    await mkdir(join(dir, "a-subdir"));

    const result = await registry.run("list_directory", { path: dir }, context);

    expect(result).toEqual({ content: "a-subdir/\nb.txt", isError: false });
  });

  it("returns a placeholder for an empty directory", async () => {
    const result = await registry.run("list_directory", { path: dir }, context);

    expect(result).toEqual({ content: "(empty directory)", isError: false });
  });

  it("returns an error for a nonexistent path", async () => {
    const result = await registry.run("list_directory", { path: join(dir, "does-not-exist") }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error listing /);
  });
});
