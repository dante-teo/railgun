import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { CONFIG_PATH } from "./paths.js";

export interface AppConfig {
  readonly model: string | null;
  readonly defaultProjectTrust: "ask" | "always" | "never";
  readonly approvalMode?: "manual" | "smart" | "off";
  readonly reviewerModel?: string;
  readonly [key: string]: unknown;
}

export const DEFAULT_CONFIG: AppConfig = { model: null, defaultProjectTrust: "ask" };

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
  const reviewerModel = merged.reviewerModel;
  if (reviewerModel !== undefined && (typeof reviewerModel !== "string" || reviewerModel.length === 0 || /\s/.test(reviewerModel))) {
    throw new ConfigError(path, '"reviewerModel" must be a non-empty string without whitespace');
  }
  return merged as AppConfig;
};

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
  const current = await loadConfig(path, options);
  const updated = validateConfig({ ...current, model }, path);
  await (options.makeDirectory ?? defaultMakeDirectory)(dirname(path));
  await (options.atomicWrite ?? defaultAtomicWrite)(path, `${JSON.stringify(updated, null, 2)}\n`);
};
