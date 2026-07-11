import { platform, release } from "node:os";
import type { DevinModel, DevinProvider } from "widevin";
import { createAuthenticatedProvider } from "./auth.js";
import { loadConfig, setConfiguredModel } from "./config.js";
import type { AppConfig } from "./config.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { loadProjectContext, loadSoulIdentity } from "./agent/projectContext.js";
import { runModelChooser } from "./repl/ModelChooser.js";
export { TOKEN_PATH } from "./sessionPath.js";

export interface DevinSession {
  devin: DevinProvider;
  model: DevinModel;
  systemPrompt: readonly string[];
}

const padDatePart = (value: number): string => String(value).padStart(2, "0");

export const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;

export const buildSessionCore = async (devin: DevinProvider, model: DevinModel, memoriesText?: string | null): Promise<DevinSession> => {
  const cwd = process.cwd();
  const [projectContext, soulIdentity] = await Promise.all([
    loadProjectContext(cwd),
    loadSoulIdentity(),
  ]);

  const systemPrompt = buildSystemPrompt({
    cwd,
    platform: platform(),
    osRelease: release(),
    startDate: formatLocalDate(new Date()),
    modelId: model.id,
    provider: "Devin",
    projectContext,
    soulIdentity,
    memories: memoriesText ?? null,
  });

  return { devin, model, systemPrompt };
};

const buildSession = async (devin: DevinProvider, model: DevinModel, memoriesText?: string | null): Promise<DevinSession> => {
  console.error(`Using model: ${model.id}`);
  return buildSessionCore(devin, model, memoriesText);
};

const availableIds = (models: readonly DevinModel[]): string =>
  models.map(candidate => candidate.id).join(", ") || "none";

export const initDevinSession = async (requiredModelId?: string, memoriesText?: string | null): Promise<DevinSession> => {
  const { devin } = await createAuthenticatedProvider();
  const models = await devin.listModels();
  const model = requiredModelId === undefined
    ? models[0]
    : models.find(candidate => candidate.id === requiredModelId);
  if (requiredModelId !== undefined && !model) {
    throw new Error(`Saved model "${requiredModelId}" is unavailable. Available models: ${availableIds(models)}.`);
  }
  if (!model) throw new Error("Devin returned no available models");
  return buildSession(devin, model, memoriesText);
};

export interface FreshSessionOptions {
  readonly config?: AppConfig;
  readonly interactive?: boolean;
  readonly selectModel?: (models: readonly DevinModel[], unavailableId: string) => Promise<string | undefined>;
  readonly persistModel?: (modelId: string) => Promise<void>;
  readonly memoriesText?: string | null;
}

export const initFreshDevinSession = async (
  options: FreshSessionOptions = {},
): Promise<DevinSession | undefined> => {
  const config = options.config ?? await loadConfig();
  const { devin } = await createAuthenticatedProvider();
  const models = await devin.listModels();
  if (models.length === 0) throw new Error("Devin returned no available models");

  const configured = config.model;
  if (configured === null) return buildSession(devin, models[0]!, options.memoriesText);

  const exact = models.find(candidate => candidate.id === configured);
  if (exact) return buildSession(devin, exact, options.memoriesText);

  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) {
    throw new Error(
      `Configured model "${configured}" is unavailable. Available models: ${availableIds(models)}. ` +
      "Launch Railgun interactively to choose and save a replacement model.",
    );
  }

  const selectedId = await (options.selectModel ?? runModelChooser)(models, configured);
  if (selectedId === undefined) return undefined;
  const selected = models.find(candidate => candidate.id === selectedId);
  if (!selected) throw new Error(`The selected model "${selectedId}" is unavailable.`);
  await (options.persistModel ?? setConfiguredModel)(selected.id);
  return buildSession(devin, selected, options.memoriesText);
};
