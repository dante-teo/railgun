import { SafeSearchType, search } from "duck-duck-scrape";
import { registry, type ToolContext, type ToolRunResult } from "./registry.js";
import { createConfiguredProviders, runProviderChain, type WebSearchProvider } from "./webSearchProviders.js";

interface SearchResultLike { title: string; url: string; description: string }
interface SearchResponseLike { noResults: boolean; results: SearchResultLike[] }
type SearchAdapter = (query: string, options: { safeSearch: SafeSearchType }, requestOptions: object) => Promise<SearchResponseLike>;

const stripMarkup = (value: string): string => value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const duckDuckGoProvider = (searchAdapter: SearchAdapter): WebSearchProvider => ({
  name: "duckduckgo", isAvailable: () => true,
  search: async (query, maxResults) => {
    const result = await searchAdapter(query, { safeSearch: SafeSearchType.MODERATE }, { timeout: 15_000 });
    return result.noResults ? [] : result.results.slice(0, maxResults).map(item => ({ title: stripMarkup(item.title), url: item.url, snippet: stripMarkup(item.description) }));
  },
});

export const createWebSearchHandler = (searchAdapter?: SearchAdapter): ((args: unknown, context: ToolContext) => Promise<ToolRunResult>) =>
  async (args, context) => {
    const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const maxResults = input.max_results === undefined ? 5 : input.max_results;
    if (!query) return { content: 'Error: web_search requires a non-empty string "query" argument.', isError: true };
    if (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 10) {
      return { content: 'Error: web_search "max_results" must be an integer between 1 and 10.', isError: true };
    }
    if (context.signal.aborted) return { content: "[stopped by user]", isError: true };

    try {
      const timeout = AbortSignal.timeout(15_000);
      const signal = AbortSignal.any([context.signal, timeout]);
      const providers = searchAdapter ? [duckDuckGoProvider(searchAdapter)] : [...createConfiguredProviders(), duckDuckGoProvider(search)];
      const result = await Promise.race([
        runProviderChain(providers, query, maxResults as number, signal),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
      return {
        content: JSON.stringify({ query, provider: result.provider, results: result.results }),
        isError: false,
      };
    } catch (error) {
      const message = errorMessage(error);
      if (context.signal.aborted) return { content: "[stopped by user]", isError: true };
      if (/All web search providers failed:.*no results/i.test(message)) return { content: `No web results found for ${JSON.stringify(query)}.`, isError: false };
      if (/captcha|challenge|bot/i.test(message)) return { content: `Web search was blocked by an upstream bot challenge: ${message}`, isError: true };
      if (/timeout|timed out|abort/i.test(message)) return { content: `Web search timed out: ${message}`, isError: true };
      return { content: `Web search failed upstream: ${message}`, isError: true };
    }
  };

registry.register({
  name: "web_search", toolset: "web", verb: "Searching", previewArgKey: "query",
  schema: {
    name: "web_search",
    description: "Search the public web through an automatic provider chain with keyless fallback. Returns normalized titles, URLs, and snippets.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Search query." },
      max_results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    }, required: ["query"] },
  },
  handler: createWebSearchHandler(),
});
