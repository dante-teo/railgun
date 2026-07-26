import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevinModel, DevinProvider } from "widevin";

const model = (id: string): DevinModel => ({
  id,
  name: id,
  provider: "devin",
  baseUrl: "https://example.test",
  input: ["text"],
  supportsTools: true,
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 8_000,
});

interface ProjectContextMock {
  readonly loadProjectContext: () => Promise<string | null>;
  readonly loadSoulIdentity: () => Promise<string | null>;
}

const emptyProjectContext: ProjectContextMock = {
  loadProjectContext: async () => null,
  loadSoulIdentity: async () => null,
};

const mockBootstrap = (
  models: readonly DevinModel[],
  projectContext: ProjectContextMock = emptyProjectContext,
) => {
  const devin: DevinProvider = {
    login: async () => "token",
    setToken: async () => {},
    clearToken: async () => {},
    listModels: async () => models,
    streamChat: async function* () { yield { type: "done", reason: "stop" }; },
  };
  vi.doMock("widevin", () => ({
    createFileTokenStore: () => ({ get: async () => "fake-token" }),
    createDevinProvider: () => devin,
  }));
  vi.doMock("./openBrowser.js", () => ({ openUrlInBrowser: async () => {} }));
  vi.doMock("./agent/projectContext.js", () => projectContext);
  vi.doMock("./agent/systemPrompt.js", () => ({ buildSystemPrompt: () => [] }));
  vi.spyOn(console, "error").mockImplementation(() => {});
};

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

describe("initFreshDevinSession", () => {
  it("retains the requested runtime surface", async () => {
    mockBootstrap([model("configured")]);
    const { initFreshDevinSession } = await import("./session.js");
    const session = await initFreshDevinSession({ config: { model: "configured" }, surface: "cron" });
    expect(session?.runtime?.surface).toBe("cron");
  });

  it("uses Devin's first returned model when config.model is null", async () => {
    mockBootstrap([model("provider-first"), model("second")]);
    const { initFreshDevinSession } = await import("./session.js");
    await expect(initFreshDevinSession({ config: { model: null } })).resolves.toMatchObject({ model: { id: "provider-first" } });
  });

  it("uses an available exact configured model", async () => {
    mockBootstrap([model("first"), model("configured")]);
    const { initFreshDevinSession } = await import("./session.js");
    await expect(initFreshDevinSession({ config: { model: "configured" } }))
      .resolves.toMatchObject({ model: { id: "configured" } });
  });

  it("fails when the configured model is unavailable", async () => {
    mockBootstrap([model("one"), model("two")]);
    const { initFreshDevinSession } = await import("./session.js");
    await expect(initFreshDevinSession({ config: { model: "missing" } })).rejects.toThrow(
      /Saved model "missing" is unavailable.*one, two/,
    );
  });
});

describe("buildSessionCore", () => {
  it("builds a session without logging to console.error", async () => {
    mockBootstrap([model("core-model")]);
    // dynamic import required: vi.doMock re-wires module graph per test
    const { buildSessionCore } = await import("./session.js");
    const devin = {
      login: async () => "token",
      setToken: async () => {},
      clearToken: async () => {},
      listModels: async () => [model("core-model")],
      streamChat: async function* () { yield { type: "done" as const, reason: "stop" as const }; },
    } satisfies DevinProvider;

    const session = await buildSessionCore(devin, model("core-model"), undefined, "desktop");

    expect(session.model.id).toBe("core-model");
    expect(session.devin).toBe(devin);
    expect(Array.isArray(session.systemPrompt)).toBe(true);
    expect(session.runtime?.surface).toBe("desktop");
    expect(console.error).not.toHaveBeenCalled();
  });
});
