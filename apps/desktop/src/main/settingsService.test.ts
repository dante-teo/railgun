import { describe, expect, it, vi } from "vitest";
import { createMutationQueue } from "./mutationQueue";
import { createSettingsService } from "./settingsService";

const controls = {
  models: [
    { id: "model-a", name: "Model A", inputs: ["text"] as const, supportsTools: true, reasoning: false, contextWindow: 10_000, maxOutputTokens: 2_000 },
    { id: "model-b", name: "Model B", inputs: ["text"] as const, supportsTools: true, reasoning: true, contextWindow: 20_000, maxOutputTokens: 4_000 },
  ],
  activeModelId: "model-a",
  defaultModelId: "model-a",
  messageCount: 0,
  moaPresets: [{ name: "pair", referenceModels: ["model-a"], aggregatorModel: "model-b" }],
  activeMoaPreset: null,
  advisor: { enabled: false, modelId: null },
  contextWindow: 10_000,
} as const;

const harness = (running = false) => {
  let config: Record<string, unknown> = {
    model: "model-a", operationTimeoutMs: 1_234, approvalMode: "smart", reviewerModel: "model-b", future: { keep: true },
  };
  const calls: Record<string, unknown>[] = [];
  const backend = {
    getSnapshot: () => ({ mode: "real" as const, phase: "ready" as const, diagnostics: ["safe detail"], transportLog: [] }),
    call: async <T,>(command: Record<string, unknown>, validate: (value: unknown) => T): Promise<T> => {
      calls.push(command);
      if (command.type === "get_state") return validate({ running });
      if (command.type === "config_get") return validate({ config });
      if (command.type === "config_update") {
        config = { ...config, ...(command.patch as Record<string, unknown>) };
        return validate({ config });
      }
      throw new Error("unexpected command");
    },
  };
  return { service: createSettingsService(backend, { get: async () => controls }, createMutationQueue()), calls, config: () => config };
};

describe("settings service", () => {
  it("projects only supported renderer-safe settings and converts timeout milliseconds", async () => {
    const { service } = harness();
    await expect(service.get()).resolves.toMatchObject({
      general: { defaultModelId: "model-a", operationTimeoutSeconds: 1.234 },
      trust: { approvalMode: "smart", reviewerModelId: "model-b" },
      diagnostics: { entries: ["safe detail"] },
    });
    expect(await service.get()).not.toHaveProperty("future");
  });

  it("writes strict section patches and leaves unknown configuration to the backend", async () => {
    const { service, calls, config } = harness();
    await service.update({ section: "general", defaultModelId: "model-b", operationTimeoutSeconds: 45 });
    expect(calls).toContainEqual({ type: "config_update", patch: { model: "model-b", operationTimeoutMs: 45_000 } });
    expect(config()).toMatchObject({ future: { keep: true } });
  });

  it("projects and persists the configured archive retention preset", async () => {
    const { service, calls } = harness();
    await expect(service.get()).resolves.toMatchObject({ archives: { archiveRetentionDays: 7 } });
    await service.update({ section: "archives", archiveRetentionDays: 30 });
    expect(calls).toContainEqual({ type: "config_update", patch: { archiveRetentionDays: 30 } });
  });

  it("rejects unavailable models, incomplete smart review, and active-run changes", async () => {
    await expect(harness().service.update({ section: "general", defaultModelId: "missing", operationTimeoutSeconds: 10 })).rejects.toThrow(/not available/u);
    await expect(harness().service.update({ section: "trust", approvalMode: "smart", reviewerModelId: null })).rejects.toThrow(/requires a model/u);
    await expect(harness(true).service.update({ section: "agent", moaPreset: null, advisor: { enabled: false, modelId: null } })).rejects.toThrow(/running/u);
  });

  it("serializes settings mutations through the injected queue", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = createMutationQueue();
    const first = queue.run(async () => { order.push("task-start"); await gate; order.push("task-end"); });
    const second = queue.run(async () => { order.push("settings"); });
    await vi.waitFor(() => expect(order).toEqual(["task-start"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["task-start", "task-end", "settings"]);
  });
});
