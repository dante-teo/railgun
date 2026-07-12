import { describe, expect, it } from "vitest";
import { deleteMoaPreset, renameMoaPreset, updateMoaPresetModels, validatePresetName } from "./settings.js";
import type { AppConfig } from "../config.js";

const config: AppConfig = {
  model: "primary",
  defaultProjectTrust: "ask",
  activeMoaPreset: "team",
  moaPresets: {
    team: {
      referenceModels: [{ model: "a", temperature: 0.2 }, { model: "b", temperature: 0.8 }],
      aggregator: { model: "agg", temperature: 0.4 },
      referenceMaxTokens: 777,
    },
  },
};

describe("MOA settings transformations", () => {
  it("renames the active preset without losing its contents", () => {
    const renamed = renameMoaPreset(config, "team", "renamed");
    expect(renamed.activeMoaPreset).toBe("renamed");
    expect(renamed.moaPresets?.["renamed"]).toEqual(config.moaPresets?.["team"]);
    expect(renamed.moaPresets?.["team"]).toBeUndefined();
  });

  it("clears the default when deleting it", () => {
    const deleted = deleteMoaPreset(config, "team");
    expect(deleted.activeMoaPreset).toBeUndefined();
    expect(deleted.moaPresets).toEqual({});
  });

  it("preserves advanced values and retained temperatures while editing models", () => {
    const updated = updateMoaPresetModels(config, "team", ["b", "new"], "agg");
    expect(updated.moaPresets?.["team"]).toEqual({
      referenceModels: [{ model: "b", temperature: 0.8 }, { model: "new" }],
      aggregator: { model: "agg", temperature: 0.4 },
      referenceMaxTokens: 777,
    });
    const changedAggregator = updateMoaPresetModels(config, "team", ["a"], "other");
    expect((changedAggregator.moaPresets?.["team"] as { aggregator: unknown }).aggregator).toEqual({ model: "other" });
  });

  it("validates non-empty unique names", () => {
    expect(validatePresetName("  ", config.moaPresets ?? {})).toMatch(/empty/);
    expect(validatePresetName("team", config.moaPresets ?? {})).toMatch(/already exists/);
    expect(validatePresetName("new", config.moaPresets ?? {})).toBeNull();
  });
});
