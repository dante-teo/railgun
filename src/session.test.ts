import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("formatLocalDate", () => {
  it("uses the host local date fields instead of UTC serialization", async () => {
    const { formatLocalDate } = await import("./session.js");
    const localDate = new Date(2026, 6, 9, 0, 30);

    expect(formatLocalDate(localDate)).toBe("2026-07-09");
  });
});

describe("initDevinSession", () => {
  it("selects an explicitly required saved model instead of the default", async () => {
    vi.doMock("widevin", () => ({
      createFileTokenStore: () => ({ get: async () => "fake-token" }),
      createDevinProvider: () => ({
        login: async () => {},
        listModels: async () => [{ id: "default-model" }, { id: "saved-model" }],
      }),
    }));
    vi.doMock("./openBrowser.js", () => ({ openUrlInBrowser: async () => {} }));
    vi.doMock("./agent/projectContext.js", () => ({
      loadProjectContext: async () => null,
      loadSoulIdentity: async () => null,
    }));
    vi.doMock("./agent/systemPrompt.js", () => ({ buildSystemPrompt: () => [] }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { initDevinSession } = await import("./session.js");
    const session = await initDevinSession("saved-model");

    expect(session.model.id).toBe("saved-model");
  });

  it("fails rather than silently switching when a saved model is unavailable", async () => {
    vi.doMock("widevin", () => ({
      createFileTokenStore: () => ({ get: async () => "fake-token" }),
      createDevinProvider: () => ({
        login: async () => {},
        listModels: async () => [{ id: "different-model" }],
      }),
    }));
    vi.doMock("./openBrowser.js", () => ({ openUrlInBrowser: async () => {} }));

    const { initDevinSession } = await import("./session.js");
    await expect(initDevinSession("missing-model")).rejects.toThrow(
      /Saved model "missing-model" is unavailable.*different-model/,
    );
  });

  it("passes projectContext and soulIdentity from loaders to buildSystemPrompt", async () => {
    vi.doMock("widevin", () => ({
      createFileTokenStore: () => ({ get: async () => "fake-token" }),
      createDevinProvider: () => ({
        login: async () => {},
        listModels: async () => [{ id: "test-model" }],
      }),
    }));

    vi.doMock("./openBrowser.js", () => ({
      openUrlInBrowser: async () => {},
    }));

    vi.doMock("./agent/projectContext.js", () => ({
      loadProjectContext: async () => "mock project context",
      loadSoulIdentity: async () => "mock soul identity",
    }));

    const buildSpy = vi.fn(() => ["prompt-block"]);
    vi.doMock("./agent/systemPrompt.js", () => ({
      buildSystemPrompt: buildSpy,
    }));

    vi.spyOn(console, "error").mockImplementation(() => {});

    const { initDevinSession } = await import("./session.js");
    await initDevinSession();

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(buildSpy.mock.calls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to inspect mock args
    const input = (buildSpy.mock.calls as any)[0][0] as Record<string, unknown>;
    expect(input).toHaveProperty("projectContext", "mock project context");
    expect(input).toHaveProperty("soulIdentity", "mock soul identity");
  });
});
