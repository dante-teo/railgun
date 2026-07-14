import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { createRpcStoreHandler } from "./storeHandlers.js";

const configHarness = (initial: AppConfig) => {
  let config = initial;
  const persist = vi.fn(async (transform: (current: Readonly<AppConfig>) => AppConfig) => {
    config = transform(config);
    return config;
  });
  const handler = createRpcStoreHandler({
    getConfig: () => config,
    setConfig: updated => { config = updated; },
    updateConfig: persist,
  });
  return { handler, getConfig: () => config, persist };
};

describe("RPC store handlers", () => {
  it("keeps legacy cron responses while supporting bounded editable pages and compact mutations", async () => {
    const jobs = [
      { id: "one", schedule: "0 9 * * *", prompt: "First", lastRun: null, requiredOutputs: ["/private/output"] },
      { id: "two", schedule: "0 10 * * *", prompt: "Second", lastRun: 123, lastError: "private error", requiredOutputs: [] },
    ] as const;
    const saveJobs = vi.fn(async () => undefined);
    const handler = createRpcStoreHandler({
      getConfig: () => ({ model: null }), setConfig: () => {}, updateConfig: vi.fn(),
      loadJobs: async () => jobs, saveJobs, randomId: () => "generated",
    });

    await expect(handler({ type: "cron_list" })).resolves.toEqual({ jobs });
    await expect(handler({ type: "cron_list", cursor: 0, limit: 1, editableOnly: true, maxPromptLength: 8_000 })).resolves.toEqual({
      jobs: [{ id: "one", schedule: "0 9 * * *", prompt: "First" }], nextCursor: 1,
    });
    await expect(handler({ type: "cron_list", cursor: 0, limit: 1, editableOnly: true, maxPromptLength: 3 })).rejects.toThrow(/prompt exceeds requested limit/iu);
    await expect(handler({ type: "cron_add", schedule: "0 11 * * *", prompt: "Third", includeJob: false })).resolves.toEqual({ jobId: "generated" });
    expect(saveJobs).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "generated", prompt: "Third" })]));
  });

  it("never returns MCP secrets and applies retain/delete environment patches", async () => {
    const harness = configHarness({
      model: null,
      mcpServers: { demo: { command: "node", args: ["server.js"], env: { TOKEN: "secret", REGION: "us" } } },
    });

    await expect(harness.handler({ type: "mcp_list" })).resolves.toEqual({
      servers: [{ name: "demo", command: "node", args: ["server.js"], env: [{ name: "REGION", present: true }, { name: "TOKEN", present: true }] }],
    });
    expect(JSON.stringify(await harness.handler({ type: "mcp_list" }))).not.toContain("secret");

    await harness.handler({ type: "mcp_upsert", name: "demo", command: "node", env: { TOKEN: null, NEW_KEY: "new-secret" } });
    expect(harness.getConfig().mcpServers).toEqual({ demo: { command: "node", args: ["server.js"], env: { REGION: "us", NEW_KEY: "new-secret" } } });
    expect(JSON.stringify(await harness.handler({ type: "mcp_list" }))).not.toContain("new-secret");
  });

  it("rejects MCP changes in generic config patches before persistence", async () => {
    const harness = configHarness({ model: null, future: { retained: true } });
    await expect(harness.handler({ type: "config_update", patch: { mcpServers: {} } })).rejects.toThrow(/MCP commands/);
    expect(harness.persist).not.toHaveBeenCalled();
    await harness.handler({ type: "config_update", patch: { approvalMode: "off" } });
    expect(harness.getConfig()).toMatchObject({ future: { retained: true }, approvalMode: "off" });
  });

  it("uses null to remove the active MoA preset while preserving unknown fields and replacing only advisor", async () => {
    const harness = configHarness({
      model: null,
      activeMoaPreset: "review",
      advisor: { enabled: true, model: "old-model" },
      future: { retained: true },
    });

    await harness.handler({
      type: "config_update",
      patch: { activeMoaPreset: null, advisor: { enabled: false, model: "new-model" } },
    });

    expect(harness.getConfig()).toEqual({
      model: null,
      advisor: { enabled: false, model: "new-model" },
      future: { retained: true },
    });
  });

  it("uses the injected embedder for semantic note searches", async () => {
    const searchSemantic = vi.fn(() => [{ id: 1, sourcePath: null, content: "note", distance: 0.1 }]);
    const embedText = vi.fn(async () => new Float32Array([1, 2]));
    const handler = createRpcStoreHandler({
      getConfig: () => ({ model: null }),
      setConfig: () => {},
      updateConfig: vi.fn(),
      noteStore: {
        search: vi.fn(), searchSemantic, storeVector: vi.fn(), importFolder: vi.fn(),
        importFolderWithEmbeddings: vi.fn(), backfillEmbeddings: vi.fn(),
      },
      embedText,
    });
    await expect(handler({ type: "notes_search", query: "meaning", mode: "semantic", limit: 3 })).resolves.toMatchObject({ notes: [{ id: 1 }] });
    expect(embedText).toHaveBeenCalledWith("meaning", "query");
    expect(searchSemantic).toHaveBeenCalledWith(expect.any(Float32Array), 3);
  });
});
