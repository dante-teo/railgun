import { z } from "zod";
import {
  SettingsSnapshotSchema,
  SettingsUpdateSchema,
} from "../shared/schemas";
import type {
  BackendSnapshot,
  ChatControlsSnapshot,
  SettingsSnapshot,
  SettingsUpdate,
} from "../shared/types";
import type { BackendRpcCommand } from "./backendSupervisor";
import type { MutationQueue } from "./mutationQueue";

interface SettingsBackend {
  call<T>(command: BackendRpcCommand, validate: (data: unknown) => T): Promise<T>;
  getSnapshot(): BackendSnapshot;
}

interface SettingsControls {
  get(): Promise<ChatControlsSnapshot>;
}

const configResponseSchema = z.strictObject({ config: z.record(z.string(), z.unknown()) });
const stateResponseSchema = z.object({ running: z.boolean() }).passthrough();

const configString = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
};

const providerFromSnapshot = (snapshot: BackendSnapshot): SettingsSnapshot["provider"] => {
  const environmentManaged = Boolean(process.env.DEVIN_TOKEN?.trim());
  if (environmentManaged) return {
    state: "environment-managed",
    source: "environment",
    message: snapshot.phase === "authentication-required"
      ? "DEVIN_TOKEN was rejected. Replace it in the launch environment, then relaunch Railgun."
      : "Devin access is managed by DEVIN_TOKEN. Cached sign-in and sign-out cannot override it.",
  };
  if (snapshot.phase === "authentication-required") return {
    state: "sign-in-required",
    source: "none",
    message: "Sign in with Devin in your browser to restore access.",
  };
  if (snapshot.phase === "ready") return {
    state: "signed-in",
    source: "cached",
    message: "Signed in with a credential cached securely for Railgun.",
  };
  return {
    state: "unavailable",
    source: "none",
    message: "Credential status is unavailable until the backend reconnects.",
  };
};

export const createSettingsService = (
  backend: SettingsBackend,
  controls: SettingsControls,
  mutations: MutationQueue,
) => {
  const get = async (): Promise<SettingsSnapshot> => {
    const snapshot = backend.getSnapshot();
    if (snapshot.phase !== "ready") return SettingsSnapshotSchema.parse({
      models: [],
      moaPresets: [],
      general: { defaultModelId: null, operationTimeoutSeconds: 600 },
      agent: { moaPreset: null, advisor: { enabled: false, modelId: null } },
      trust: { approvalMode: "manual", reviewerModelId: null },
      archives: { archiveRetentionDays: 7 },
      provider: providerFromSnapshot(snapshot),
      diagnostics: {
        phase: snapshot.phase,
        message: snapshot.error ?? "Backend is not ready.",
        entries: snapshot.diagnostics.slice(-20),
        mockMode: snapshot.mode === "mock",
      },
      running: false,
    });
    const [chatControls, configResponse, state] = await Promise.all([
      controls.get(),
      backend.call({ type: "config_get" }, value => configResponseSchema.parse(value)),
      backend.call({ type: "get_state" }, value => stateResponseSchema.parse(value)),
    ]);
    const config = configResponse.config;
    const timeoutMs = config.operationTimeoutMs ?? 600_000;
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) {
      throw new Error("Operation timeout is invalid");
    }
    const approvalMode = config.approvalMode ?? "manual";
    const reviewerModelId = configString(config.reviewerModel, "Smart review model");
    const archiveRetentionDays = config.archiveRetentionDays ?? 7;
    return SettingsSnapshotSchema.parse({
      models: chatControls.models,
      moaPresets: chatControls.moaPresets,
      general: {
        defaultModelId: chatControls.defaultModelId,
        operationTimeoutSeconds: (timeoutMs as number) / 1_000,
      },
      agent: { moaPreset: chatControls.activeMoaPreset, advisor: chatControls.advisor },
      trust: { approvalMode, reviewerModelId },
      archives: { archiveRetentionDays },
      provider: providerFromSnapshot(snapshot),
      diagnostics: {
        phase: snapshot.phase,
        message: snapshot.error ?? (snapshot.phase === "ready" ? "Backend is healthy." : "Backend is not ready."),
        entries: snapshot.diagnostics.slice(-20),
        mockMode: snapshot.mode === "mock",
      },
      running: state.running,
    });
  };

  const update = (rawUpdate: SettingsUpdate): Promise<SettingsSnapshot> => mutations.run(async () => {
    const update = SettingsUpdateSchema.parse(rawUpdate);
    const before = await get();
    if (before.running) throw new Error("Settings cannot be changed while the agent is running");
    const modelIds = new Set(before.models.map(model => model.id));
    const requireModel = (id: string | null, label: string): void => {
      if (id !== null && !modelIds.has(id)) throw new Error(`${label} is not available`);
    };
    let patch: Record<string, unknown>;
    switch (update.section) {
      case "general":
        requireModel(update.defaultModelId, "Default model");
        patch = { model: update.defaultModelId, operationTimeoutMs: update.operationTimeoutSeconds * 1_000 };
        break;
      case "agent":
        if (update.moaPreset !== null && !before.moaPresets.some(preset => preset.name === update.moaPreset)) {
          throw new Error("MoA preset is not available");
        }
        requireModel(update.advisor.modelId, "Advisor model");
        patch = {
          activeMoaPreset: update.moaPreset,
          advisor: {
            enabled: update.advisor.enabled,
            ...(update.advisor.modelId === null ? {} : { model: update.advisor.modelId }),
          },
        };
        break;
      case "trust":
        requireModel(update.reviewerModelId, "Smart review model");
        patch = {
          approvalMode: update.approvalMode,
          ...(update.reviewerModelId === null ? { reviewerModel: undefined } : { reviewerModel: update.reviewerModelId }),
        };
        break;
      case "archives":
        patch = { archiveRetentionDays: update.archiveRetentionDays };
        break;
    }
    await backend.call({ type: "config_update", patch }, value => configResponseSchema.parse(value));
    return get();
  });

  return { get, update };
};
