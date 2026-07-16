import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, isAdvisorActive, loadConfig, mergeConfig, parseMoAPreset, setConfiguredModel, updateConfig } from "./config.js";

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
    await expect(loadConfig(path)).resolves.toEqual({ model: null, operationTimeoutMs: 600_000, archiveRetentionDays: 7 });
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
    await expect(loadConfig(path)).resolves.toEqual({ model, operationTimeoutMs: 600_000, archiveRetentionDays: 7, unknown: { keep: true } });
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array root", "[]"],
    ["a null root", "null"],
    ["an empty model", '{"model":""}'],
    ["a whitespace model", '{"model":"  x  "}'],
    ["a model containing whitespace", '{"model":"model id"}'],
    ["a non-string model", '{"model":42}'],
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

describe("archiveRetentionDays validation", () => {
  it.each([1, 7, 30, 90])("accepts the supported retention preset %i", async archiveRetentionDays => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ archiveRetentionDays }));
    await expect(loadConfig(path)).resolves.toMatchObject({ archiveRetentionDays });
  });

  it.each([0, 2, 8, 365, 7.5, "7", null])("rejects an unsupported retention preset %j", async archiveRetentionDays => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ archiveRetentionDays }));
    await expect(loadConfig(path)).rejects.toThrow(/archiveRetentionDays/u);
  });
});

describe("operationTimeoutMs validation", () => {
  it("accepts a custom positive integer", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ operationTimeoutMs: 1234 }));
    await expect(loadConfig(path)).resolves.toMatchObject({ operationTimeoutMs: 1234 });
  });

  it.each([0, -1, 1.5, "1000", null])("rejects invalid value %j", async operationTimeoutMs => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ operationTimeoutMs }));
    await expect(loadConfig(path)).rejects.toThrow(/operationTimeoutMs/);
  });
});

describe("approvalMode validation", () => {
  it.each(["manual", "smart", "off"])("accepts valid approvalMode %j", async mode => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, approvalMode: mode }));
    await expect(loadConfig(path)).resolves.toMatchObject({ approvalMode: mode });
  });

  it("rejects invalid approvalMode", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, approvalMode: "yolo" }));
    await expect(loadConfig(path)).rejects.toThrow(/approvalMode/);
  });

  it("preserves approvalMode through mergeConfig round-trip", () => {
    expect(mergeConfig({ model: null }, { approvalMode: "smart" })).toMatchObject({ approvalMode: "smart" });
  });

  it("accepts valid reviewerModel", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, reviewerModel: "some-model" }));
    await expect(loadConfig(path)).resolves.toMatchObject({ reviewerModel: "some-model" });
  });

  it("rejects empty reviewerModel", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, reviewerModel: "" }));
    await expect(loadConfig(path)).rejects.toThrow(/reviewerModel/);
  });

  it("rejects reviewerModel with whitespace", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, reviewerModel: "model with space" }));
    await expect(loadConfig(path)).rejects.toThrow(/reviewerModel/);
  });

  it("accepts config with both approvalMode and reviewerModel", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, approvalMode: "smart", reviewerModel: "reviewer-model" }));
    await expect(loadConfig(path)).resolves.toMatchObject({ approvalMode: "smart", reviewerModel: "reviewer-model" });
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

    expect(atomicWrite).toHaveBeenLastCalledWith(path, '{\n  "model": "replacement",\n  "operationTimeoutMs": 600000,\n  "archiveRetentionDays": 7,\n  "unknown": {\n    "keep": true\n  }\n}\n');
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "replacement", operationTimeoutMs: 600_000, archiveRetentionDays: 7, unknown: { keep: true } });
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

describe("updateConfig", () => {
  it("atomically validates a functional update and preserves unknown fields", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: "old", unknown: { keep: true } }));
    const atomicWrite = vi.fn(async (target: string, contents: string) => writeFile(target, contents));

    const updated = await updateConfig(current => ({
      ...current,
      advisor: { enabled: true, model: "advisor-model" },
    }), path, { atomicWrite });

    expect(updated).toMatchObject({ model: "old", unknown: { keep: true }, advisor: { enabled: true, model: "advisor-model" } });
    expect(atomicWrite).toHaveBeenCalledOnce();
  });

  it("does not write an invalid transformed config", async () => {
    const atomicWrite = vi.fn();
    await expect(updateConfig(current => ({ ...current, advisor: { enabled: true } }), path, { atomicWrite }))
      .rejects.toThrow(/no model/);
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});

describe("moaPresets validation", () => {
  it("accepts a valid moaPresets config", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: {
        dual: {
          referenceModels: [{ model: "ref-a" }, { model: "ref-b" }],
          aggregator: { model: "agg-model" },
          referenceMaxTokens: 600,
        },
      },
    }));
    await expect(loadConfig(path)).resolves.toMatchObject({ moaPresets: { dual: expect.any(Object) } });
  });

  it("accepts moaPresets with no referenceMaxTokens", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: {
        simple: {
          referenceModels: [{ model: "ref" }],
          aggregator: { model: "agg" },
        },
      },
    }));
    await expect(loadConfig(path)).resolves.toMatchObject({ moaPresets: expect.any(Object) });
  });

  it("rejects moaPresets with missing referenceModels", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: { bad: { aggregator: { model: "agg" } } },
    }));
    await expect(loadConfig(path)).rejects.toThrow(/referenceModels/);
  });

  it("rejects moaPresets with missing aggregator.model", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: { bad: { referenceModels: [{ model: "ref" }], aggregator: {} } },
    }));
    await expect(loadConfig(path)).rejects.toThrow(/aggregator/);
  });

  it("rejects moaPresets with non-numeric referenceMaxTokens", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: {
        bad: { referenceModels: [{ model: "ref" }], aggregator: { model: "agg" }, referenceMaxTokens: "many" },
      },
    }));
    await expect(loadConfig(path)).rejects.toThrow(/referenceMaxTokens/);
  });

  it("rejects more than 8 reference models", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      model: null,
      moaPresets: {
        toobig: {
          referenceModels: Array.from({ length: 9 }, (_, i) => ({ model: `ref-${i}` })),
          aggregator: { model: "agg" },
        },
      },
    }));
    await expect(loadConfig(path)).rejects.toThrow(/at most 8/);
  });
});

describe("parseMoAPreset", () => {
  it("returns typed MoAPreset for valid input", () => {
    const result = parseMoAPreset("dual", {
      referenceModels: [{ model: "ref-a" }, { model: "ref-b" }],
      aggregator: { model: "agg" },
      referenceMaxTokens: 500,
    });
    expect(result.name).toBe("dual");
    expect(result.referenceModels).toHaveLength(2);
    expect(result.aggregator.model).toBe("agg");
    expect(result.referenceMaxTokens).toBe(500);
  });

  it("ignores unknown extra keys (forward-compatible)", () => {
    const result = parseMoAPreset("future", {
      referenceModels: [{ model: "ref", unknownField: true }],
      aggregator: { model: "agg", anotherField: "x" },
      futureOption: 42,
    });
    expect(result.name).toBe("future");
    expect(result.referenceModels[0]?.model).toBe("ref");
  });

  it("throws ConfigError for non-object input", () => {
    expect(() => parseMoAPreset("bad", "not-an-object")).toThrow(ConfigError);
  });

  it("throws ConfigError for missing referenceModels", () => {
    expect(() => parseMoAPreset("bad", { aggregator: { model: "agg" } })).toThrow(ConfigError);
  });

  it("throws ConfigError for empty referenceModels array", () => {
    expect(() => parseMoAPreset("bad", { referenceModels: [], aggregator: { model: "agg" } })).toThrow(ConfigError);
  });

  it("throws ConfigError for missing aggregator.model", () => {
    expect(() => parseMoAPreset("bad", { referenceModels: [{ model: "r" }], aggregator: {} })).toThrow(ConfigError);
  });

  it("throws ConfigError for non-numeric referenceMaxTokens", () => {
    expect(() => parseMoAPreset("bad", {
      referenceModels: [{ model: "r" }],
      aggregator: { model: "a" },
      referenceMaxTokens: "lots",
    })).toThrow(ConfigError);
  });

  it("accepts optional temperature on model slots", () => {
    const result = parseMoAPreset("warm", {
      referenceModels: [{ model: "ref", temperature: 0.7 }],
      aggregator: { model: "agg", temperature: 0.5 },
    });
    expect(result.referenceModels[0]?.temperature).toBe(0.7);
    expect(result.aggregator.temperature).toBe(0.5);
  });
});

describe("advisor config", () => {
  it("accepts advisor with enabled and model", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: true, model: "cheap-model" } }));
    await expect(loadConfig(path)).resolves.toMatchObject({ advisor: { enabled: true, model: "cheap-model" } });
  });

  it("accepts advisor with enabled: false and no model", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: false } }));
    await expect(loadConfig(path)).resolves.toMatchObject({ advisor: { enabled: false } });
  });

  it("rejects advisor enabled but no model", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: true } }));
    await expect(loadConfig(path)).rejects.toThrow('"advisor" is enabled but no model is assigned');
  });

  it("rejects advisor with empty model string", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: true, model: "" } }));
    await expect(loadConfig(path)).rejects.toThrow('"advisor.model" must be a non-empty string without whitespace');
  });

  it("rejects advisor that is not an object", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: "not-an-object" }));
    await expect(loadConfig(path)).rejects.toThrow('"advisor" must be an object');
  });

  it("isAdvisorActive returns true when enabled and model are set", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: true, model: "advisor-model" } }));
    const config = await loadConfig(path);
    expect(isAdvisorActive(config)).toBe(true);
  });

  it("isAdvisorActive returns false when enabled is false", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: false, model: "advisor-model" } }));
    const config = await loadConfig(path);
    expect(isAdvisorActive(config)).toBe(false);
  });

  it("rejects advisor with non-boolean enabled", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null, advisor: { enabled: "yes" } }));
    await expect(loadConfig(path)).rejects.toThrow('"advisor.enabled" must be a boolean');
  });

  it("isAdvisorActive returns false when advisor is absent", async () => {
    path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ model: null }));
    const config = await loadConfig(path);
    expect(isAdvisorActive(config)).toBe(false);
  });
});
