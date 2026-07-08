import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./readFile.js";

const context: ToolContext = {
  confirmShellCommand: async () => {
    throw new Error("read_file must not request shell approval");
  }
};

describe("read_file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-readfile-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the file's contents on success", async () => {
    const filePath = join(dir, "secret.txt");
    await writeFile(filePath, "the secret is 42", "utf-8");

    const result = await registry.run("read_file", { path: filePath }, context);

    expect(result).toEqual({ content: "the secret is 42", isError: false });
  });

  it("returns an error for a nonexistent file", async () => {
    const missingPath = "/definitely/does/not/exist.txt";

    const result = await registry.run("read_file", { path: missingPath }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error reading \/definitely\/does\/not\/exist\.txt: /);
  });

  it("returns a fixed error for a missing/invalid path argument without touching the filesystem", async () => {
    const result = await registry.run("read_file", {}, context);

    expect(result).toEqual({
      content: 'Error: read_file requires a string "path" argument',
      isError: true
    });
  });
});
