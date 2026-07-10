import { platform, release } from "node:os";
import type { DevinModel, DevinProvider } from "widevin";
import { createAuthenticatedProvider } from "./auth.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { loadProjectContext, loadSoulIdentity } from "./agent/projectContext.js";
export { TOKEN_PATH } from "./sessionPath.js";

export interface DevinSession {
  devin: DevinProvider;
  model: DevinModel;
  systemPrompt: readonly string[];
}

const padDatePart = (value: number): string => String(value).padStart(2, "0");

export const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;

export const initDevinSession = async (requiredModelId?: string): Promise<DevinSession> => {
  const { devin } = await createAuthenticatedProvider();
  const models = await devin.listModels();
  const model = requiredModelId === undefined
    ? models[0]
    : models.find(candidate => candidate.id === requiredModelId);
  if (requiredModelId !== undefined && !model) {
    const available = models.map(candidate => candidate.id).join(", ") || "none";
    throw new Error(`Saved model "${requiredModelId}" is unavailable. Available models: ${available}.`);
  }
  if (!model) throw new Error("Devin returned no available models");
  console.error(`Using model: ${model.id}`);

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
  });

  return { devin, model, systemPrompt };
};
