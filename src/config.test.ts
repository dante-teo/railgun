import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

describe("CONFIG_PATH", () => {
  it("lives under ~/.railgun/", () => {
    expect(CONFIG_PATH).toMatch(/\.railgun\/config\.json$/);
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns { skin: 'default' } when the file does not exist", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    expect(await loadConfig()).toEqual({ skin: "default" });
  });

  it("returns { skin: 'default' } when the file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValue("not json{{{");
    expect(await loadConfig()).toEqual({ skin: "default" });
  });

  it("returns { skin: 'default' } when the file contains an unrecognized skin name", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ skin: "nonexistent" }));
    expect(await loadConfig()).toEqual({ skin: "default" });
  });

  it("returns { skin: 'mono' } when the file contains valid { skin: 'mono' }", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ skin: "mono" }));
    expect(await loadConfig()).toEqual({ skin: "mono" });
  });

  it("returns { skin: 'default' } when JSON is valid but has no skin field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ other: "value" }));
    expect(await loadConfig()).toEqual({ skin: "default" });
  });
});

describe("saveConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("creates the directory with recursive: true then writes the config", async () => {
    await saveConfig({ skin: "mono" });

    expect(mockMkdir).toHaveBeenCalledOnce();
    expect(String(mockMkdir.mock.calls[0]?.[0])).toMatch(/\.railgun$/);
    expect(mockMkdir.mock.calls[0]?.[1]).toEqual({ recursive: true });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile.mock.calls[0]?.[0]).toBe(CONFIG_PATH);
    expect(JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string)).toEqual({ skin: "mono" });
    expect(mockWriteFile.mock.calls[0]?.[2]).toBe("utf8");
  });
});
