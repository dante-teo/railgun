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
  it("never returns MCP secrets and applies retain/delete environment patches", async () => {
    const harness = configHarness({
      model: null,
      defaultProjectTrust: "ask",
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
    const harness = configHarness({ model: null, defaultProjectTrust: "ask", future: { retained: true } });
    await expect(harness.handler({ type: "config_update", patch: { mcpServers: {} } })).rejects.toThrow(/MCP commands/);
    expect(harness.persist).not.toHaveBeenCalled();
    await harness.handler({ type: "config_update", patch: { approvalMode: "off" } });
    expect(harness.getConfig()).toMatchObject({ future: { retained: true }, approvalMode: "off" });
  });

  it("uses the injected embedder for semantic note searches", async () => {
    const searchSemantic = vi.fn(() => [{ id: 1, sourcePath: null, content: "note", distance: 0.1 }]);
    const embedText = vi.fn(async () => new Float32Array([1, 2]));
    const handler = createRpcStoreHandler({
      getConfig: () => ({ model: null, defaultProjectTrust: "ask" }),
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
