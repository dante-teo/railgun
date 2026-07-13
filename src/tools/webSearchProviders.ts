export interface WebSearchResult { title: string; url: string; snippet: string }
export interface WebSearchProvider {
  name: string;
  isAvailable: () => boolean;
  search: (query: string, maxResults: number, signal: AbortSignal) => Promise<WebSearchResult[]>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const clean = (value: unknown): string =>
  typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const arrayField = (record: Record<string, unknown>, key: string): unknown[] =>
  Array.isArray(record[key]) ? record[key] : [];

const configured = (value: string | undefined): boolean => Boolean(value?.trim());

const normalize = (items: unknown[], titleKey = "title", urlKey = "url", snippetKey = "description"): WebSearchResult[] =>
  items.flatMap(value => {
    const item = asRecord(value);
    const url = clean(item?.[urlKey]);
    return url ? [{ title: clean(item?.[titleKey]) || url, url, snippet: clean(item?.[snippetKey]) }] : [];
  });

const truncateSnippet = (result: WebSearchResult): WebSearchResult => ({
  ...result,
  snippet: result.snippet.length > 800 ? `${result.snippet.slice(0, 797)}...` : result.snippet,
});

export const runProviderChain = async (providers: readonly WebSearchProvider[], query: string, maxResults: number, signal: AbortSignal) => {
  const failures: string[] = [];
  for (const provider of providers.filter(item => item.isAvailable())) {
    signal.throwIfAborted();
    try {
      const results = (await provider.search(query, maxResults, signal)).slice(0, maxResults).map(truncateSnippet);
      if (results.length > 0) return { provider: provider.name, results };
      failures.push(`${provider.name}: no results`);
    } catch (error) {
      signal.throwIfAborted();
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.length ? `All web search providers failed: ${failures.join("; ")}` : "No web search provider is configured");
};

const parseExaText = (text: string): WebSearchResult[] => text.split(/\n\s*---\s*\n/).flatMap(section => {
  const title = section.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const url = section.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
  const snippet = section.match(/^Highlights:\s*\n([\s\S]*)$/m)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return url ? [{ title: title || url, url, snippet }] : [];
});

export const searchExaMcp = async (query: string, maxResults: number, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<WebSearchResult[]> => {
  const response = await fetcher("https://mcp.exa.ai/mcp?tools=web_search_exa", {
    method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "web_search_exa", arguments: { query, num_results: maxResults } } }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const dataLines = (await response.text()).split("\n").filter(line => line.startsWith("data: "));
  for (const line of dataLines) {
    const payload = asRecord(JSON.parse(line.slice(6)));
    const result = asRecord(payload?.result) ?? {};
    const text = arrayField(result, "content")
      .map(item => asRecord(item)?.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const parsed = parseExaText(text);
    if (parsed.length) return parsed.slice(0, maxResults);
  }
  throw new Error("unexpected response shape");
};

const jsonRequest = async (url: string | URL, init: RequestInit, fetcher: Fetcher): Promise<Record<string, unknown>> => {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return asRecord(await response.json()) ?? {};
};

export const createConfiguredProviders = (env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): WebSearchProvider[] => [
  {
    name: "brave", isAvailable: () => configured(env.BRAVE_API_KEY),
    search: async (query, limit, signal) => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(limit));
      const data = await jsonRequest(url, { signal, headers: { accept: "application/json", "x-subscription-token": env.BRAVE_API_KEY ?? "" } }, fetcher);
      return normalize(arrayField(asRecord(data.web) ?? {}, "results"));
    },
  },
  {
    name: "tavily", isAvailable: () => configured(env.TAVILY_API_KEY),
    search: async (query, limit, signal) => {
      const data = await jsonRequest("https://api.tavily.com/search", { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY ?? ""}` }, body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }) }, fetcher);
      return normalize(arrayField(data, "results"), "title", "url", "content");
    },
  },
  {
    name: "jina", isAvailable: () => configured(env.JINA_API_KEY),
    search: async (query, limit, signal) => {
      const data = await jsonRequest(`https://s.jina.ai/${encodeURIComponent(query)}`, { signal, headers: { accept: "application/json", authorization: `Bearer ${env.JINA_API_KEY ?? ""}` } }, fetcher);
      return normalize(arrayField(data, "data"), "title", "url", "content").slice(0, limit);
    },
  },
  {
    name: "searxng", isAvailable: () => configured(env.SEARXNG_ENDPOINT),
    search: async (query, limit, signal) => {
      const endpoint = env.SEARXNG_ENDPOINT ?? "";
      const url = new URL("search", `${endpoint.replace(/\/+$/, "")}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const headers = { accept: "application/json", ...(env.SEARXNG_TOKEN ? { authorization: `Bearer ${env.SEARXNG_TOKEN}` } : {}) };
      const data = await jsonRequest(url, { signal, headers }, fetcher);
      return normalize(arrayField(data, "results"), "title", "url", "content").slice(0, limit);
    },
  },
  { name: "exa", isAvailable: () => true, search: (query, limit, signal) => searchExaMcp(query, limit, signal, fetcher) },
];
