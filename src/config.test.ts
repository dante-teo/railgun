import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, mergeConfig, setConfiguredModel } from "./config.js";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "railgun-config-"));
  path = join(directory, "nested", "config.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("uses the effective defaults when the file is missing without creating it", async () => {
    await expect(loadConfig(path)).resolves.toEqual({ model: null, defaultProjectTrust: "ask" });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recursively merges objects and preserves unknown user fields", () => {
    expect(mergeConfig(
      { model: null, future: { enabled: false, nested: { default: 1 } } },
      { future: { enabled: true, nested: { user: 2 } }, extra: ["kept"] },
    )).toEqual({
      model: null,
      future: { enabled: true, nested: { default: 1, user: 2 } },
      extra: ["kept"],
    });
  });

  it.each([null, "devin-model"])('accepts model %j', async model => {
    await writeFile(path = join(directory, "config.json"), JSON.stringify({ model, unknown: { keep: true } }));
    await expect(loadConfig(path)).resolves.toEqual({ model, defaultProjectTrust: "ask", unknown: { keep: true } });
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array root", "[]"],
    ["a null root", "null"],
    ["an empty model", '{"model":""}'],
    ["a whitespace model", '{"model":"  x  "}'],
    ["a model containing whitespace", '{"model":"model id"}'],
    ["a non-string model", '{"model":42}'],
    ["an invalid defaultProjectTrust", '{"defaultProjectTrust":"sometimes"}'],
  ])("rejects %s and identifies the config path", async (_label, contents) => {
    path = join(directory, "config.json");
    await writeFile(path, contents);
    await expect(loadConfig(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reports non-missing read errors with the path", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await expect(loadConfig("/blocked/config.json", { readFile: vi.fn(async () => { throw failure; }) }))
      .rejects.toMatchObject({ name: "ConfigError", path: "/blocked/config.json" } satisfies Partial<ConfigError>);
  });
});

describe("setConfiguredModel", () => {
  it("atomically replaces the model while preserving user fields and formatting the file", async () => {
    path = join(directory, "home", "config.json");
    const atomicWrite = vi.fn(async (target: string, contents: string) => {
      await writeFile(target, contents);
    });
    await setConfiguredModel("replacement", path, { atomicWrite });
    await writeFile(path, '{"model":"old","unknown":{"keep":true}}');

    await setConfiguredModel("replacement", path, { atomicWrite });

    expect(atomicWrite).toHaveBeenLastCalledWith(path, '{\n  "model": "replacement",\n  "defaultProjectTrust": "ask",\n  "unknown": {\n    "keep": true\n  }\n}\n');
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "replacement", defaultProjectTrust: "ask", unknown: { keep: true } });
  });

  it("does not invoke the writer or alter an invalid config", async () => {
    path = join(directory, "config.json");
    await writeFile(path, "not-json");
    const atomicWrite = vi.fn();
    await expect(setConfiguredModel("replacement", path, { atomicWrite })).rejects.toBeInstanceOf(ConfigError);
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("not-json");
  });
});
