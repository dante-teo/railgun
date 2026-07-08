import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./writeFile.js";

const context: ToolContext = {
  confirmShellCommand: async () => {
    throw new Error("write_file must not request shell approval");
  }
};

describe("write_file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-writefile-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a file and reports the byte count", async () => {
    const filePath = join(dir, "hello.txt");

    const result = await registry.run("write_file", { path: filePath, content: "hi" }, context);

    expect(result).toEqual({ content: "Wrote 2 bytes to " + filePath, isError: false });
    expect(await readFile(filePath, "utf-8")).toBe("hi");
  });

  it("returns a fixed error and creates no file when content is missing", async () => {
    const filePath = join(dir, "hello.txt");

    const result = await registry.run("write_file", { path: filePath }, context);

    expect(result).toEqual({
      content: 'Error: write_file requires a string "content" argument',
      isError: true
    });
    await expect(stat(filePath)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns a fixed error when path is missing", async () => {
    const result = await registry.run("write_file", { content: "hi" }, context);

    expect(result).toEqual({
      content: 'Error: write_file requires a string "path" argument',
      isError: true
    });
  });
});
