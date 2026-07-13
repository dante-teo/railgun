import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { registry, type ToolContext, type ToolRunResult } from "./registry.js";

const USER_AGENT = "Railgun/0.1 (+https://github.com/dantea/railgun)";
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 200_000;

type FetchAdapter = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
type ResolveAdapter = (hostname: string) => Promise<readonly string[]>;

const resolveAddresses: ResolveAdapter = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
const nonPublicRanges = new Set(["unspecified", "broadcast", "multicast", "linkLocal", "loopback", "private", "reserved", "carrierGradeNat", "uniqueLocal", "ipv4Mapped"]);
const normalizedHostname = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

export const isPublicAddress = (address: string): boolean => {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) return false;
    return !nonPublicRanges.has(parsed.range());
  } catch { return false; }
};

const parsePublicUrl = (raw: string): URL => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("malformed URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only HTTP(S) URLs are supported");
  if (url.username || url.password) throw new Error("credentials in URLs are not allowed");
  if (!url.hostname || url.hostname.toLowerCase() === "localhost" || url.hostname.toLowerCase().endsWith(".localhost")) throw new Error("localhost is not allowed");
  const hostname = normalizedHostname(url.hostname);
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) throw new Error("URL resolves to a non-public address");
  return url;
};

const readLimitedBody = async (response: Response, signal: AbortSignal): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    if (signal.aborted) { await reader.cancel(); throw signal.reason; }
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} byte limit`); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
};

const extractContent = (body: string, contentType: string, url: string): { title?: string; content: string } => {
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try { return { content: JSON.stringify(JSON.parse(body), null, 2) }; } catch { return { content: body }; }
  }
  if (contentType.startsWith("text/plain")) return { content: body };
  const dom = new JSDOM(body, { url });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title?.trim() || dom.window.document.title.trim() || undefined;
  const content = article?.textContent?.replace(/\s+\n/g, "\n").trim() || dom.window.document.body?.textContent?.replace(/\s+/g, " ").trim() || "";
  return { ...(title ? { title } : {}), content };
};

export const createWebFetchHandler = (fetcher: FetchAdapter = undiciFetch as FetchAdapter, resolver: ResolveAdapter = resolveAddresses) =>
  async (args: unknown, context: ToolContext): Promise<ToolRunResult> => {
    const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
    if (typeof input.url !== "string" || !input.url.trim()) return { content: 'Error: web_fetch requires a string "url" argument.', isError: true };
    const maxChars = input.max_chars === undefined ? DEFAULT_MAX_CHARS : input.max_chars;
    if (!Number.isInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > MAX_OUTPUT_CHARS) {
      return { content: `Error: web_fetch "max_chars" must be an integer between 1 and ${MAX_OUTPUT_CHARS}.`, isError: true };
    }
    const timeout = AbortSignal.timeout(20_000);
    const signal = AbortSignal.any([context.signal, timeout]);
    let current: URL;
    try { current = parsePublicUrl(input.url); } catch (error) { return { content: `Error: unsafe URL: ${String(error)}`, isError: true }; }

    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const hostname = normalizedHostname(current.hostname);
        const addresses = ipaddr.isValid(hostname) ? [hostname] : await resolver(hostname);
        if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) throw new Error("hostname resolved to a non-public or unavailable address");
        let nextAddress = 0;
        const dispatcher = new Agent({ connect: { lookup: (_host, _options, callback) => {
          const address = addresses[nextAddress++ % addresses.length] as string;
          callback(null, address, ipaddr.parse(address).kind() === "ipv4" ? 4 : 6);
        } } });
        try {
          const response = await fetcher(current.href, { method: "GET", redirect: "manual", signal, dispatcher, headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" } });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) throw new Error(`redirect (${response.status}) did not include a Location header`);
            if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (maximum ${MAX_REDIRECTS})`);
            current = parsePublicUrl(new URL(location, current).href);
            continue;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
          const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
          if (!(contentType === "text/html" || contentType === "application/xhtml+xml" || contentType.startsWith("text/plain") || contentType === "application/json" || contentType.endsWith("+json"))) {
            throw new Error(`unsupported content type: ${contentType || "unknown"}`);
          }
          const declaredSize = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
          const extracted = extractContent(await readLimitedBody(response, signal), contentType, current.href);
          const truncated = extracted.content.length > (maxChars as number);
          return { content: JSON.stringify({ final_url: current.href, ...(extracted.title ? { title: extracted.title } : {}), content_type: contentType, content: extracted.content.slice(0, maxChars as number), truncated }), isError: false };
        } finally { await dispatcher.close(); }
      }
      throw new Error("too many redirects");
    } catch (error) {
      if (context.signal.aborted) return { content: "[stopped by user]", isError: true };
      return { content: `Web fetch failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  };

registry.register({
  name: "web_fetch", toolset: "web", verb: "Fetching", previewArgKey: "url",
  schema: { name: "web_fetch", description: "Fetch readable text from a public HTTP(S) URL. Supports HTML, plain text, and JSON; private networks and binary files are blocked.", inputSchema: {
    type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer", minimum: 1, maximum: MAX_OUTPUT_CHARS, default: DEFAULT_MAX_CHARS } }, required: ["url"],
  } }, handler: createWebFetchHandler(),
});
