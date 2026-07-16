# 0030. Built-in public web search and fetch

Date: 2026-07-13

## Status

Accepted

## Context

Railgun needed read-only internet access without requiring an MCP server or an
API key for first use. A single unofficial DuckDuckGo scraper proved
insufficient because DuckDuckGo can return a bot challenge instead of results.
URL retrieval also creates an SSRF boundary because an apparently public
hostname can resolve or redirect to a private service.

## Decision

### Search provider chain

`web_search({ query, max_results? })` is registered under the always-enabled
`"web"` toolset. `src/tools/webSearchProviders.ts` normalizes every provider to
`{ title, url, snippet }` and tries available providers sequentially:

1. Brave when `BRAVE_API_KEY` is present.
2. Tavily when `TAVILY_API_KEY` is present.
3. Jina when `JINA_API_KEY` is present.
4. SearXNG when `SEARXNG_ENDPOINT` is present, with optional `SEARXNG_TOKEN`.
5. Exa's public MCP endpoint as the zero-configuration provider.
6. DuckDuckGo's unofficial scraper as the final best-effort fallback.

Failures and empty responses advance to the next provider. Output identifies
the successful provider, snippets are bounded, and cancellation stops the
chain instead of being treated as a provider failure.

### Public URL retrieval

`web_fetch({ url, max_chars? })` supports HTML, plain text, and JSON. HTML is
extracted with Mozilla Readability and falls back to document text. It does not
execute JavaScript or parse PDFs and other binary formats.

Every request and redirect is restricted to public HTTP(S). Credentials and
other schemes are rejected. DNS answers are checked with `ipaddr.js`; loopback,
private, link-local, multicast, unspecified, carrier-grade NAT, reserved, and
IPv4-mapped IPv6 ranges are blocked. Undici connections are pinned to validated
answers to prevent DNS rebinding. Bracketed IPv6 literals are normalized before
address validation while the original URL remains the request target.

Redirect count, elapsed time, response bytes, declared content length, and
returned characters are bounded. A stable Railgun user agent identifies the
client.

DNS results are reduced to a validated IPv4/IPv6 pair, with the second address
tried after a transient transport failure. Retryable HTTP failures, exhausted
direct connections, empty HTML, and recognizable bot-challenge pages then use
Jina Reader (`r.jina.ai`) as an automatic keyless fallback. The original target
is validated before fallback, and Jina's own connection is resolved, validated,
and pinned in the same way. This fallback discloses the requested public URL to
Jina; it requires no credential and remains subject to Jina's unauthenticated
rate limit.

A successful fallback retains the public page target in `final_url` and
adds `reader: "jina"` to the result payload. Direct responses omit this field,
so tool consumers can distinguish the extraction path without treating the
Reader endpoint as the fetched source.

### Availability and model behavior

`src/tools/toolsets.ts` is the single source for default toolsets. Primary and
delegated agents receive `"web"`; only primary/orchestrator agents add
`"delegation"`. Both web tools are parallel-safe. The system prompt directs the
model to fetch promising sources and report search failure instead of bypassing
safeguards with shell HTTP clients such as `curl`.

## Consequences

- First use requires no search key; configured providers improve reliability
  and quota isolation.
- Exa MCP and DuckDuckGo remain external best-effort services.
- Private-network fetching is intentionally unavailable, including redirects
  from public pages.
- Some failed direct requests are sent to Jina Reader for keyless extraction;
  failures from both paths are reported together.
- Providers can be added without changing the public tool schema.
- Undici 8 and jsdom 29 raise the runtime floor to Node.js 22.19.0.
