import { describe, expect, it, vi } from "vitest";
import { createConfiguredProviders, runProviderChain, searchExaMcp, type WebSearchProvider } from "./webSearchProviders.js";

const provider = (name: string, result: unknown): WebSearchProvider => ({
  name, isAvailable: () => true,
  search: vi.fn().mockImplementation(() => result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
});

describe("web search provider chain", () => {
  it("falls through failures and empty responses", async () => {
    const first = provider("first", new Error("down"));
    const empty = provider("empty", []);
    const working = provider("working", [{ title: "Found", url: "https://example.com", snippet: "Text" }]);
    const result = await runProviderChain([first, empty, working], "query", 5, new AbortController().signal);
    expect(result).toEqual({ provider: "working", results: [{ title: "Found", url: "https://example.com", snippet: "Text" }] });
  });

  it("skips unavailable providers and reports every attempted failure", async () => {
    const unavailable: WebSearchProvider = { name: "missing-key", isAvailable: () => false, search: vi.fn() };
    await expect(runProviderChain([unavailable, provider("broken", new Error("blocked"))], "q", 5, new AbortController().signal))
      .rejects.toThrow("broken: blocked");
    expect(unavailable.search).not.toHaveBeenCalled();
  });

  it("parses Exa MCP SSE text into normalized results", async () => {
    const text = "Title: Example\nURL: https://example.com\nPublished: N/A\nAuthor: N/A\nHighlights:\nUseful snippet";
    const fetcher = vi.fn().mockResolvedValue(new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n\n`, { status: 200 }));
    expect(await searchExaMcp("test", 3, new AbortController().signal, fetcher)).toEqual([
      { title: "Example", url: "https://example.com", snippet: "Useful snippet" },
    ]);
  });

  it("admits only configured credentialed providers while keeping Exa keyless", () => {
    const providers = createConfiguredProviders({ BRAVE_API_KEY: "brave", SEARXNG_ENDPOINT: "https://search.example" });
    expect(providers.map(item => [item.name, item.isAvailable()])).toEqual([
      ["brave", true], ["tavily", false], ["jina", false], ["searxng", true], ["exa", true],
    ]);
  });

  it("truncates oversized snippets at the provider-chain boundary", async () => {
    const result = await runProviderChain([
      provider("long", [{ title: "Result", url: "https://example.com", snippet: "x".repeat(900) }]),
    ], "query", 5, new AbortController().signal);
    expect(result.results[0]?.snippet).toHaveLength(800);
    expect(result.results[0]?.snippet.endsWith("...")).toBe(true);
  });
});
