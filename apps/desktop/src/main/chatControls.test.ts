import { describe, expect, it, vi } from "vitest";
import { createChatControlsService } from "./chatControls";
import type { ChatControlsBackend } from "./chatControls";

const model = {
  id: "model-a", name: "Model A", provider: "devin", baseUrl: "https://example.test",
  input: ["text", "image"], supportsTools: true, reasoning: true, contextWindow: 200_000, maxTokens: 16_000,
} as const;

const responses = () => ({
  get_available_models: { models: [model] },
  get_state: { running: false, model: "model-a", messageCount: 2, todos: [] },
  config_get: { config: {
    model: "model-a",
    moaPresets: { review: { referenceModels: [{ model: "ref-a" }], aggregator: { model: "model-a" }, referenceMaxTokens: 4_000 } },
    activeMoaPreset: "review",
    advisor: { enabled: true, model: "ref-a" },
    unknownSecret: "never forwarded",
  } },
});

const harness = (overrides: Partial<Record<string, unknown>> = {}) => {
  const data = { ...responses(), ...overrides } as Record<string, unknown>;
  const call = vi.fn(async <T,>(command: { readonly type: string }, validate: (value: unknown) => T): Promise<T> => {
    if (command.type === "set_model" || command.type === "compact") return validate(undefined);
    if (command.type === "config_update") return validate(data.config_update ?? data.config_get);
    return validate(data[command.type]);
  });
  return { call, service: createChatControlsService({ call: call as unknown as ChatControlsBackend["call"] }) };
};

describe("chat controls service", () => {
  it("builds a bounded snapshot and omits unknown configuration", async () => {
    const { service } = harness();
    await expect(service.get()).resolves.toEqual({
      models: [{ id: "model-a", name: "Model A", inputs: ["text", "image"], supportsTools: true, reasoning: true, contextWindow: 200_000, maxOutputTokens: 16_000 }],
      activeModelId: "model-a", defaultModelId: "model-a", messageCount: 2,
      moaPresets: [{ name: "review", referenceModels: ["ref-a"], aggregatorModel: "model-a", referenceMaxTokens: 4_000 }],
      activeMoaPreset: "review", advisor: { enabled: true, modelId: "ref-a" }, contextWindow: 200_000,
    });
  });

  it("switches the chat before saving a default and reports a recoverable partial failure", async () => {
    const { call, service } = harness();
    call.mockImplementation(async <T,>(command: { readonly type: string }, validate: (value: unknown) => T): Promise<T> => {
      if (command.type === "set_model") return validate(undefined);
      if (command.type === "config_update") throw new Error("disk full");
      const values = responses() as Record<string, unknown>;
      return validate(command.type === "get_state" ? { ...values.get_state as object, model: "model-a" } : values[command.type]);
    });
    const result = await service.setModel("model-a");
    expect(call.mock.calls.map(([command]) => command.type)).toContain("set_model");
    expect(result.persistence).toBe("partial");
    expect(result.warning).toContain("default was not saved");
  });

  it("removes MoA, replaces advisor configuration, and rejects invalid selections", async () => {
    const { call, service } = harness();
    await service.update({ moaPreset: null, advisor: { enabled: false, modelId: "model-a" } });
    expect(call).toHaveBeenCalledWith(
      { type: "config_update", patch: { activeMoaPreset: null, advisor: { enabled: false, model: "model-a" } } },
      expect.any(Function),
    );
    await expect(service.update({ moaPreset: "missing" })).rejects.toThrow("unknown MoA preset");
    await expect(service.update({ advisor: { enabled: true, modelId: null } })).rejects.toThrow();
    await expect(service.update({ advisor: { enabled: true, modelId: "missing" } })).rejects.toThrow("unknown advisor model");
  });

  it("rejects compaction for an empty or running chat", async () => {
    await expect(harness({ get_state: { running: false, model: "model-a", messageCount: 0, todos: [] } }).service.compact())
      .rejects.toThrow("empty");
    await expect(harness({ get_state: { running: true, model: "model-a", messageCount: 2, todos: [] } }).service.compact())
      .rejects.toThrow("running");
  });
});
