import { z } from "zod";
import {
  AgentControlUpdateSchema,
  ChatControlsSnapshotSchema,
  ControlMutationResultSchema,
  DESKTOP_CONTROL_LIMITS,
  ModelPersistenceModeSchema,
} from "../shared/schemas";
import type {
  AgentControlUpdate,
  ChatControlsSnapshot,
  ControlMutationResult,
  ModelPersistenceMode,
} from "../shared/types";
import type { BackendRpcCommand } from "./backendSupervisor";

export interface ChatControlsBackend {
  call<T>(command: BackendRpcCommand, validate: (data: unknown) => T): Promise<T>;
}

const modelId = z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.modelId);
const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const backendModelSchema = z.strictObject({
  id: modelId,
  name: z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.modelName),
  provider: z.literal("devin"),
  baseUrl: z.string().max(2_048),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).readonly(),
  supportsTools: z.literal(true),
  reasoning: z.boolean(),
  contextWindow: tokenLimit,
  maxTokens: tokenLimit,
});
const modelsResponseSchema = z.strictObject({
  models: z.array(backendModelSchema).max(DESKTOP_CONTROL_LIMITS.models).readonly(),
});
const stateResponseSchema = z.object({
  running: z.boolean(),
  model: modelId,
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).passthrough();
const configResponseSchema = z.strictObject({ config: z.record(z.string(), z.unknown()) });

type RawConfig = z.infer<typeof configResponseSchema>["config"];
type RawModel = z.infer<typeof backendModelSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, label: string): string => {
  const parsed = modelId.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a valid model ID`);
  return parsed.data;
};

const parsePreset = (name: string, value: unknown) => {
  if (!isRecord(value)) throw new Error(`Invalid MoA preset: ${name}`);
  const preset = value;
  if (!Array.isArray(preset.referenceModels) || preset.referenceModels.length === 0 || preset.referenceModels.length > DESKTOP_CONTROL_LIMITS.referenceModels) {
    throw new Error(`Invalid MoA preset reference models: ${name}`);
  }
  const referenceModels = preset.referenceModels.map((slot, index) => {
    if (!isRecord(slot)) throw new Error(`Invalid MoA reference ${String(index)}: ${name}`);
    return nonEmptyString(slot.model, `MoA preset ${name}`);
  });
  if (!isRecord(preset.aggregator)) {
    throw new Error(`Invalid MoA aggregator: ${name}`);
  }
  const referenceMaxTokens = preset.referenceMaxTokens === undefined ? undefined : tokenLimit.parse(preset.referenceMaxTokens);
  return {
    name,
    referenceModels,
    aggregatorModel: nonEmptyString(preset.aggregator.model, `MoA preset ${name}`),
    ...(referenceMaxTokens === undefined ? {} : { referenceMaxTokens }),
  };
};

const parseConfig = (config: RawConfig) => {
  const defaultModelId = config.model === null || config.model === undefined
    ? null
    : nonEmptyString(config.model, "Configured model");
  const rawPresets = config.moaPresets;
  if (rawPresets !== undefined && !isRecord(rawPresets)) throw new Error("Invalid MoA presets configuration");
  const entries = Object.entries(rawPresets ?? {});
  if (entries.length > DESKTOP_CONTROL_LIMITS.presets) throw new Error("Too many MoA presets");
  const moaPresets = entries.map(([name, value]) => parsePreset(name, value));
  const activeMoaPreset = config.activeMoaPreset === undefined || config.activeMoaPreset === null
    ? null
    : z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.presetName).parse(config.activeMoaPreset);
  if (activeMoaPreset !== null && !moaPresets.some(preset => preset.name === activeMoaPreset)) {
    throw new Error(`Configured active MoA preset is unknown: ${activeMoaPreset}`);
  }
  const rawAdvisor = config.advisor;
  if (rawAdvisor !== undefined && !isRecord(rawAdvisor)) throw new Error("Invalid advisor configuration");
  const advisorConfig = rawAdvisor;
  const enabled = advisorConfig?.enabled === undefined ? false : z.boolean().parse(advisorConfig.enabled);
  const advisorModel = advisorConfig?.model === undefined ? null : nonEmptyString(advisorConfig.model, "Advisor model");
  if (enabled && advisorModel === null) throw new Error("Enabled advisor requires a model");
  return { defaultModelId, moaPresets, activeMoaPreset, advisor: { enabled, modelId: advisorModel } };
};

const toDesktopModel = (model: RawModel) => ({
  id: model.id,
  name: model.name,
  inputs: model.input,
  supportsTools: model.supportsTools,
  reasoning: model.reasoning,
  contextWindow: model.contextWindow,
  maxOutputTokens: model.maxTokens,
});

const validateEmpty = (value: unknown): undefined => {
  if (value !== undefined) throw new Error("Backend RPC returned unexpected response data");
  return undefined;
};

export const createChatControlsService = (backend: ChatControlsBackend) => {
  const load = async (): Promise<{ readonly controls: ChatControlsSnapshot; readonly running: boolean }> => {
    const [catalog, state, configResponse] = await Promise.all([
      backend.call({ type: "get_available_models" }, value => modelsResponseSchema.parse(value)),
      backend.call({ type: "get_state" }, value => stateResponseSchema.parse(value)),
      backend.call({ type: "config_get" }, value => configResponseSchema.parse(value)),
    ]);
    const models = catalog.models.map(toDesktopModel);
    const config = parseConfig(configResponse.config);
    const controls = ChatControlsSnapshotSchema.parse({
      models,
      activeModelId: state.model,
      defaultModelId: config.defaultModelId,
      messageCount: state.messageCount,
      moaPresets: config.moaPresets,
      activeMoaPreset: config.activeMoaPreset,
      advisor: config.advisor,
      contextWindow: models.find(model => model.id === state.model)?.contextWindow ?? null,
    });
    return { controls, running: state.running };
  };
  const get = async (): Promise<ChatControlsSnapshot> => (await load()).controls;

  let mutationQueue = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationQueue.then(operation);
    mutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const setModel = (rawModelId: string, rawPersistence: ModelPersistenceMode): Promise<ControlMutationResult> => mutate(async () => {
    const selectedModelId = modelId.parse(rawModelId);
    const persistence = ModelPersistenceModeSchema.parse(rawPersistence);
    const before = await get();
    if (!before.models.some(model => model.id === selectedModelId)) throw new Error(`Unknown model: ${selectedModelId}`);
    await backend.call({ type: "set_model", modelId: selectedModelId }, validateEmpty);
    if (persistence === "chat") {
      return ControlMutationResultSchema.parse({ controls: await get(), persistence: "session-only" });
    }
    try {
      await backend.call(
        { type: "config_update", patch: { model: selectedModelId } },
        value => configResponseSchema.parse(value),
      );
      return ControlMutationResultSchema.parse({ controls: await get(), persistence: "saved" });
    } catch (error) {
      return ControlMutationResultSchema.parse({
        controls: await get(),
        persistence: "partial",
        warning: `This chat changed to ${selectedModelId}, but the default was not saved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  const update = (rawUpdate: AgentControlUpdate): Promise<ControlMutationResult> => mutate(async () => {
    const update = AgentControlUpdateSchema.parse(rawUpdate);
    const controls = await get();
    if (update.moaPreset !== undefined && update.moaPreset !== null && !controls.moaPresets.some(preset => preset.name === update.moaPreset)) {
      throw new Error(`Cannot select unknown MoA preset: ${update.moaPreset}`);
    }
    if (update.advisor?.modelId !== null && update.advisor?.modelId !== undefined &&
      !controls.models.some(model => model.id === update.advisor?.modelId)) {
      throw new Error(`Cannot select unknown advisor model: ${update.advisor.modelId}`);
    }
    const patch = {
      ...(update.moaPreset === undefined ? {} : { activeMoaPreset: update.moaPreset }),
      ...(update.advisor === undefined ? {} : {
        advisor: { enabled: update.advisor.enabled, ...(update.advisor.modelId === null ? {} : { model: update.advisor.modelId }) },
      }),
    };
    await backend.call({ type: "config_update", patch }, value => configResponseSchema.parse(value));
    return ControlMutationResultSchema.parse({ controls: await get(), persistence: "saved" });
  });

  const compact = (): Promise<ControlMutationResult> => mutate(async () => {
    const { controls, running } = await load();
    if (running) throw new Error("Cannot compact context while the agent is running");
    if (controls.messageCount === 0) throw new Error("Cannot compact an empty chat");
    await backend.call({ type: "compact" }, validateEmpty);
    return ControlMutationResultSchema.parse({ controls: await get(), persistence: "session-only" });
  });

  return { get, setModel, update, compact };
};
