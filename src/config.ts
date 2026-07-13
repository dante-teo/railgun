import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { MoAPreset } from "./agent/moa.js";
import { CONFIG_PATH } from "./paths.js";

export interface AppConfig {
  readonly model: string | null;
  readonly defaultProjectTrust: "ask" | "always" | "never";
  readonly approvalMode?: "manual" | "smart" | "off";
  readonly reviewerModel?: string;
  readonly moaPresets?: Record<string, unknown>;
  readonly activeMoaPreset?: string;
  readonly advisor?: { readonly enabled?: boolean; readonly model?: string };
  readonly operationTimeoutMs?: number;
  readonly [key: string]: unknown;
}

export const DEFAULT_CONFIG: AppConfig = { model: null, defaultProjectTrust: "ask", operationTimeoutMs: 600_000 };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const mergeConfig = (defaults: JsonObject, user: JsonObject): JsonObject =>
  Object.fromEntries([
    ...Object.entries(defaults),
    ...Object.entries(user).map(([key, value]) => [
      key,
      isObject(defaults[key]) && isObject(value)
        ? mergeConfig(defaults[key], value)
        : value,
    ]),
  ]);

export class ConfigError extends Error {
  readonly name = "ConfigError";

  constructor(readonly path: string, detail: string, options?: ErrorOptions) {
    super(`Invalid Railgun configuration at ${path}: ${detail}`, options);
  }
}

interface ConfigReadOptions {
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

interface ConfigWriteOptions extends ConfigReadOptions {
  readonly atomicWrite?: (path: string, contents: string) => Promise<unknown>;
  readonly makeDirectory?: (path: string) => Promise<unknown>;
}

const validateConfig = (value: unknown, path: string): AppConfig => {
  if (!isObject(value)) throw new ConfigError(path, "the JSON root must be an object");
  const merged = mergeConfig(DEFAULT_CONFIG, value);
  const model = merged.model;
  if (model !== null && typeof model !== "string") {
    throw new ConfigError(path, '"model" must be a string or null');
  }
  if (typeof model === "string" && (model.length === 0 || /\s/.test(model))) {
    throw new ConfigError(path, '"model" must be a non-empty string without whitespace, or null');
  }
  const trust = merged.defaultProjectTrust;
  if (trust !== "ask" && trust !== "always" && trust !== "never") {
    throw new ConfigError(path, '"defaultProjectTrust" must be "ask", "always", or "never"');
  }
  const approvalMode = merged.approvalMode;
  if (approvalMode !== undefined && approvalMode !== "manual" && approvalMode !== "smart" && approvalMode !== "off") {
    throw new ConfigError(path, '"approvalMode" must be "manual", "smart", or "off"');
  }
  const operationTimeoutMs = merged.operationTimeoutMs;
  if (!Number.isInteger(operationTimeoutMs) || (operationTimeoutMs as number) <= 0) {
    throw new ConfigError(path, '"operationTimeoutMs" must be a positive integer');
  }
  const reviewerModel = merged.reviewerModel;
  if (reviewerModel !== undefined && (typeof reviewerModel !== "string" || reviewerModel.length === 0 || /\s/.test(reviewerModel))) {
    throw new ConfigError(path, '"reviewerModel" must be a non-empty string without whitespace');
  }
  const moaPresets = merged.moaPresets;
  if (moaPresets !== undefined) {
    if (!isObject(moaPresets)) throw new ConfigError(path, '"moaPresets" must be an object');
    for (const [presetName, presetValue] of Object.entries(moaPresets)) {
      try {
        parseMoAPreset(presetName, presetValue);
      } catch (error) {
        const detail = error instanceof ConfigError ? error.message.replace(/^[^:]+: /, "") : (error instanceof Error ? error.message : String(error));
        throw new ConfigError(path, `moaPresets["${presetName}"]: ${detail}`);
      }
    }
  }
  const activeMoaPreset = merged.activeMoaPreset;
  if (activeMoaPreset !== undefined && (typeof activeMoaPreset !== "string" || activeMoaPreset.length === 0)) {
    throw new ConfigError(path, '"activeMoaPreset" must be a non-empty string');
  }
  if (typeof activeMoaPreset === "string" && isObject(moaPresets) && !(activeMoaPreset in moaPresets)) {
    throw new ConfigError(path, `"activeMoaPreset" refers to unknown preset "${activeMoaPreset}"`);
  }
  const advisor = merged.advisor;
  if (advisor !== undefined) {
    if (!isObject(advisor)) throw new ConfigError(path, '"advisor" must be an object');
    if (advisor.enabled !== undefined && typeof advisor.enabled !== "boolean") {
      throw new ConfigError(path, '"advisor.enabled" must be a boolean');
    }
    if (advisor.model !== undefined) {
      if (typeof advisor.model !== "string" || advisor.model.length === 0 || /\s/.test(advisor.model)) {
        throw new ConfigError(path, '"advisor.model" must be a non-empty string without whitespace');
      }
    }
    if (advisor.enabled === true && !advisor.model) {
      throw new ConfigError(path, '"advisor" is enabled but no model is assigned');
    }
  }
  return merged as AppConfig;
};

export const parseMoAPreset = (name: string, raw: unknown): MoAPreset => {
  const p = (field: string): string => `moaPresets["${name}"].${field}`;
  if (!isObject(raw)) throw new ConfigError("moaPresets config", `moaPresets["${name}"] must be an object`);

  const parseModelSlot = (slot: unknown, field: string) => {
    if (!isObject(slot)) throw new ConfigError("moaPresets config", `${field} must be an object`);
    const model = slot["model"];
    if (typeof model !== "string" || model.length === 0) {
      throw new ConfigError("moaPresets config", `${field}.model must be a non-empty string`);
    }
    const temperature = slot["temperature"];
    if (temperature !== undefined && typeof temperature !== "number") {
      throw new ConfigError("moaPresets config", `${field}.temperature must be a number`);
    }
    return { model, ...(temperature !== undefined ? { temperature } : {}) };
  };

  const refModels = raw["referenceModels"];
  if (!Array.isArray(refModels)) throw new ConfigError("moaPresets config", `${p("referenceModels")} must be an array`);
  if (refModels.length === 0) throw new ConfigError("moaPresets config", `${p("referenceModels")} must not be empty`);
  if (refModels.length > 8) throw new ConfigError("moaPresets config", `${p("referenceModels")} must have at most 8 entries`);
  const referenceModels = refModels.map((slot: unknown, i: number) =>
    parseModelSlot(slot, p(`referenceModels[${i}]`))
  );

  const aggregator = parseModelSlot(raw["aggregator"], p("aggregator"));

  const referenceMaxTokens = raw["referenceMaxTokens"];
  if (referenceMaxTokens !== undefined && (typeof referenceMaxTokens !== "number" || referenceMaxTokens <= 0)) {
    throw new ConfigError("moaPresets config", `${p("referenceMaxTokens")} must be a positive number`);
  }
  return {
    name,
    referenceModels,
    aggregator,
    ...(referenceMaxTokens !== undefined ? { referenceMaxTokens } : {}),
  };
};
export const isAdvisorActive = (config: AppConfig): boolean =>
  config.advisor?.enabled === true && typeof config.advisor.model === "string" && config.advisor.model.length > 0;

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export const loadConfig = async (
  path = CONFIG_PATH,
  options: ConfigReadOptions = {},
): Promise<AppConfig> => {
  let contents: string;
  try {
    contents = await (options.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { ...DEFAULT_CONFIG };
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, `could not read the file: ${detail}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ConfigError(path, "the file contains malformed JSON", { cause: error });
  }
  return validateConfig(value, path);
};

const defaultAtomicWrite = (path: string, contents: string): Promise<void> =>
  writeFileAtomic(path, contents, { encoding: "utf8", mode: 0o600 });

const defaultMakeDirectory = (path: string): Promise<string | undefined> =>
  mkdir(path, { recursive: true, mode: 0o700 });

export const setConfiguredModel = async (
  model: string,
  path = CONFIG_PATH,
  options: ConfigWriteOptions = {},
): Promise<void> => {
  await updateConfig(current => ({ ...current, model }), path, options);
};

export const updateConfig = async (
  transform: (current: Readonly<AppConfig>) => AppConfig,
  path = CONFIG_PATH,
  options: ConfigWriteOptions = {},
): Promise<AppConfig> => {
  const current = await loadConfig(path, options);
  const updated = validateConfig(transform(current), path);
  await (options.makeDirectory ?? defaultMakeDirectory)(dirname(path));
  await (options.atomicWrite ?? defaultAtomicWrite)(path, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
};
