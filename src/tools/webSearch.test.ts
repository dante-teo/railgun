import { describe, expect, it, vi } from "vitest";
import { createWebSearchHandler } from "./webSearch.js";

const context = (signal = new AbortController().signal) => ({
  signal, commandApprovalMode: "off" as const, sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => true,
});

describe("web_search", () => {
  it("validates arguments", async () => {
    const handler = createWebSearchHandler(vi.fn());
    expect((await handler({}, context())).isError).toBe(true);
    expect((await handler({ query: "x", max_results: 11 }, context())).content).toMatch(/1 and 10/);
  });

  it("normalizes and limits results with moderate SafeSearch", async () => {
    const search = vi.fn().mockResolvedValue({ noResults: false, results: [
      { title: " One ", url: "https://one.test", description: "<b>First</b> result" },
      { title: "Two", url: "https://two.test", description: "Second" },
    ] });
    const result = await createWebSearchHandler(search)({ query: "railgun", max_results: 1 }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ query: "railgun", provider: "duckduckgo", results: [
      { title: "One", url: "https://one.test", snippet: "First result" },
    ] });
    expect(search).toHaveBeenCalledWith("railgun", expect.objectContaining({ safeSearch: -1 }), expect.anything());
  });

  it("reports empty results, challenge failures, and cancellation clearly", async () => {
    const empty = createWebSearchHandler(vi.fn().mockResolvedValue({ noResults: true, results: [] }));
    expect((await empty({ query: "none" }, context())).content).toMatch(/No web results/);
    const challenge = createWebSearchHandler(vi.fn().mockRejectedValue(new Error("DuckDuckGo CAPTCHA challenge")));
    expect((await challenge({ query: "x" }, context())).content).toMatch(/challenge/i);
    const controller = new AbortController(); controller.abort();
    expect((await empty({ query: "x" }, context(controller.signal))).content).toMatch(/stopped/i);
  });
});
