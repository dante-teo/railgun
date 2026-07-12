import type { AppConfig } from "../config.js";

type Presets = NonNullable<AppConfig["moaPresets"]>;
type RawPreset = Record<string, unknown>;
type ModelSlot = { readonly model: string; readonly temperature?: number };

const asPreset = (value: unknown): RawPreset => value as RawPreset;
const asSlots = (value: unknown): readonly ModelSlot[] => value as readonly ModelSlot[];
const asSlot = (value: unknown): ModelSlot => value as ModelSlot;

export const validatePresetName = (name: string, presets: Presets, original?: string): string | null => {
  const normalized = name.trim();
  if (normalized === "") return "Preset name cannot be empty.";
  if (normalized !== original && Object.hasOwn(presets, normalized)) return `A preset named "${normalized}" already exists.`;
  return null;
};

export const renameMoaPreset = (config: AppConfig, from: string, to: string): AppConfig => {
  const presets = config.moaPresets ?? {};
  const preset = presets[from];
  if (preset === undefined || validatePresetName(to, presets, from)) return config;
  const name = to.trim();
  return {
    ...config,
    moaPresets: Object.fromEntries(Object.entries(presets).flatMap(([key, value]) => key === from ? [[name, value]] : [[key, value]])),
    ...(config.activeMoaPreset === from ? { activeMoaPreset: name } : {}),
  };
};

export const deleteMoaPreset = (config: AppConfig, name: string): AppConfig => {
  const moaPresets = Object.fromEntries(Object.entries(config.moaPresets ?? {}).filter(([key]) => key !== name));
  if (config.activeMoaPreset !== name) return { ...config, moaPresets };
  const { activeMoaPreset: _removed, ...withoutActive } = config;
  return { ...withoutActive, moaPresets };
};

export const updateMoaPresetModels = (
  config: AppConfig,
  name: string,
  referenceModelIds: readonly string[],
  aggregatorModelId: string,
): AppConfig => {
  const raw = asPreset(config.moaPresets?.[name]);
  const priorReferences = asSlots(raw.referenceModels);
  const referenceModels = referenceModelIds.map(model => priorReferences.find(slot => slot.model === model) ?? { model });
  const priorAggregator = asSlot(raw.aggregator);
  const aggregator = priorAggregator.model === aggregatorModelId ? priorAggregator : { model: aggregatorModelId };
  return {
    ...config,
    moaPresets: { ...config.moaPresets, [name]: { ...raw, referenceModels, aggregator } },
  };
};

export const createMoaPreset = (
  config: AppConfig,
  name: string,
  referenceModelIds: readonly string[],
  aggregatorModelId: string,
): AppConfig => ({
  ...config,
  moaPresets: {
    ...config.moaPresets,
    [name.trim()]: { referenceModels: referenceModelIds.map(model => ({ model })), aggregator: { model: aggregatorModelId } },
  },
});
