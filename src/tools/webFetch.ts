import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { registry, type ToolContext, type ToolRunResult } from "./registry.js";

const USER_AGENT = "Railgun/0.1 (+https://github.com/dantea/railgun)";
const JINA_READER_ORIGIN = "https://r.jina.ai";
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_ADDRESS_ATTEMPTS = 2;
const DIRECT_ATTEMPT_TIMEOUT_MS = 10_000;
const READER_ATTEMPT_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 45_000;

type FetchAdapter = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
type ResolveAdapter = (hostname: string) => Promise<readonly string[]>;
type ExtractedContent = { title?: string; content: string };
type FetchPayload = ExtractedContent & { finalUrl: string; contentType: string; reader?: "jina" };
type ResponseSnapshot = { status: number; statusText: string; headers: Headers; body: string };

class RecoverableDirectFetchError extends Error {
  constructor(readonly url: URL, message: string) { super(message); }
}

class ResponseLimitError extends Error {}

const resolveAddresses: ResolveAdapter = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
const nonPublicRanges = new Set(["unspecified", "broadcast", "multicast", "linkLocal", "loopback", "private", "reserved", "carrierGradeNat", "uniqueLocal", "ipv4Mapped"]);
const normalizedHostname = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
const errorMessage = (error: unknown, causeDepth = 0): string => {
  if (!(error instanceof Error)) return String(error);
  return error.cause !== undefined && causeDepth < 3
    ? `${error.message}: ${errorMessage(error.cause, causeDepth + 1)}`
    : error.message;
};

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

const prioritizeAddresses = (addresses: readonly string[]): readonly string[] => {
  const firstByFamily = ["ipv4", "ipv6"].flatMap(family => addresses.find(address => ipaddr.parse(address).kind() === family) ?? []);
  return [...new Set([...firstByFamily, ...addresses])].slice(0, MAX_ADDRESS_ATTEMPTS);
};

const validatedAddresses = async (url: URL, resolver: ResolveAdapter): Promise<readonly string[]> => {
  const hostname = normalizedHostname(url.hostname);
  const addresses = ipaddr.isValid(hostname) ? [hostname] : await resolver(hostname);
  if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) {
    throw new Error("hostname resolved to a non-public or unavailable address");
  }
  return prioritizeAddresses(addresses);
};

export const createPinnedLookup = (address: string): LookupFunction => (_hostname, options, callback) => {
  const family = ipaddr.parse(address).kind() === "ipv4" ? 4 : 6;
  callback(null, options.all ? [{ address, family }] : address, options.all ? undefined : family);
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
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseLimitError(`response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
};

const contentTypeOf = (headers: Headers): string =>
  (headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();

const isSupportedContentType = (contentType: string): boolean =>
  contentType === "text/html"
  || contentType === "application/xhtml+xml"
  || contentType.startsWith("text/plain")
  || contentType === "application/json"
  || contentType.endsWith("+json");

const shouldReadResponse = (response: Response): boolean => {
  const contentType = contentTypeOf(response.headers);
  const declaredSize = Number(response.headers.get("content-length"));
  return response.ok
    && isSupportedContentType(contentType)
    && !(Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES);
};

const fetchAtAddress = async (
  url: URL,
  address: string,
  fetcher: FetchAdapter,
  signal: AbortSignal,
  attemptTimeoutMs: number,
): Promise<ResponseSnapshot> => {
  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(address) } });
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]);
  try {
    const response = await fetcher(url.href, {
      method: "GET",
      redirect: "manual",
      signal: requestSignal,
      dispatcher,
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
    });
    const body = shouldReadResponse(response)
      ? await readLimitedBody(response, requestSignal)
      : (await response.body?.cancel(), "");
    return { status: response.status, statusText: response.statusText, headers: response.headers, body };
  } finally {
    await dispatcher.close();
  }
};

const fetchAcrossAddresses = async (
  url: URL,
  addresses: readonly string[],
  fetcher: FetchAdapter,
  signal: AbortSignal,
  attemptTimeoutMs: number,
): Promise<ResponseSnapshot> => {
  const attempt = async (remaining: readonly string[], failures: readonly string[]): Promise<ResponseSnapshot> => {
    signal.throwIfAborted();
    const [address, ...rest] = remaining;
    if (!address) throw new Error(failures.at(-1) ?? "no public address was available");
    try {
      return await fetchAtAddress(url, address, fetcher, signal, attemptTimeoutMs);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ResponseLimitError) throw error;
      return attempt(rest, [...failures, `${address}: ${errorMessage(error)}`]);
    }
  };
  return attempt(addresses, []);
};

const extractContent = (body: string, contentType: string, url: string): ExtractedContent => {
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

const looksLikeBotChallenge = (content: string): boolean =>
  content.length < 1_000
  && /enable javascript|captcha|checking your browser|verify you are human|access denied|attention required|bot detection|cloudflare/i.test(content);

const recoverableHttpStatuses = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

const fetchDirect = async (
  initialUrl: URL,
  fetcher: FetchAdapter,
  resolver: ResolveAdapter,
  signal: AbortSignal,
): Promise<FetchPayload> => {
  const followRedirects = async (current: URL, redirects: number): Promise<FetchPayload> => {
    const addresses = await validatedAddresses(current, resolver);
    let snapshot: ResponseSnapshot;
    try {
      snapshot = await fetchAcrossAddresses(current, addresses, fetcher, signal, DIRECT_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ResponseLimitError) throw error;
      signal.throwIfAborted();
      throw new RecoverableDirectFetchError(current, errorMessage(error));
    }
    if (snapshot.status >= 300 && snapshot.status < 400) {
      const location = snapshot.headers.get("location");
      if (!location) throw new Error(`redirect (${snapshot.status}) did not include a Location header`);
      if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (maximum ${MAX_REDIRECTS})`);
      return followRedirects(parsePublicUrl(new URL(location, current).href), redirects + 1);
    }
    if (snapshot.status < 200 || snapshot.status >= 300) {
      const message = `HTTP ${snapshot.status} ${snapshot.statusText}`.trim();
      if (recoverableHttpStatuses.has(snapshot.status)) throw new RecoverableDirectFetchError(current, message);
      throw new Error(message);
    }
    const contentType = contentTypeOf(snapshot.headers);
    if (!isSupportedContentType(contentType)) throw new Error(`unsupported content type: ${contentType || "unknown"}`);
    const declaredSize = Number(snapshot.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) throw new ResponseLimitError(`response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
    const extracted = extractContent(snapshot.body, contentType, current.href);
    if ((contentType === "text/html" || contentType === "application/xhtml+xml") && (!extracted.content || looksLikeBotChallenge(extracted.content))) {
      throw new RecoverableDirectFetchError(current, "page returned empty or blocked HTML");
    }
    return { finalUrl: current.href, contentType, ...extracted };
  };
  return followRedirects(initialUrl, 0);
};

const fetchWithJinaReader = async (
  target: URL,
  fetcher: FetchAdapter,
  resolver: ResolveAdapter,
  signal: AbortSignal,
): Promise<FetchPayload> => {
  const readerUrl = new URL(`${JINA_READER_ORIGIN}/${target.href}`);
  const addresses = await validatedAddresses(readerUrl, resolver);
  const snapshot = await fetchAcrossAddresses(readerUrl, addresses, fetcher, signal, READER_ATTEMPT_TIMEOUT_MS);
  if (snapshot.status < 200 || snapshot.status >= 300) throw new Error(`Jina Reader returned HTTP ${snapshot.status} ${snapshot.statusText}`.trim());
  const contentType = contentTypeOf(snapshot.headers);
  if (!isSupportedContentType(contentType)) throw new Error(`Jina Reader returned unsupported content type: ${contentType || "unknown"}`);
  if (!snapshot.body.trim()) throw new Error("Jina Reader returned empty content");
  return { finalUrl: target.href, contentType, content: snapshot.body, reader: "jina" };
};

const fetchWithFallback = async (
  initialUrl: URL,
  fetcher: FetchAdapter,
  resolver: ResolveAdapter,
  signal: AbortSignal,
): Promise<FetchPayload> => {
  try {
    return await fetchDirect(initialUrl, fetcher, resolver, signal);
  } catch (error) {
    if (!(error instanceof RecoverableDirectFetchError)) throw error;
    signal.throwIfAborted();
    try {
      return await fetchWithJinaReader(error.url, fetcher, resolver, signal);
    } catch (readerError) {
      throw new Error(`direct request failed (${error.message}); keyless reader fallback failed (${errorMessage(readerError)})`);
    }
  }
};

const formatResult = (payload: FetchPayload, maxChars: number): ToolRunResult => ({
  content: JSON.stringify({
    final_url: payload.finalUrl,
    ...(payload.title ? { title: payload.title } : {}),
    content_type: payload.contentType,
    content: payload.content.slice(0, maxChars),
    truncated: payload.content.length > maxChars,
    ...(payload.reader ? { reader: payload.reader } : {}),
  }),
  isError: false,
});

export const createWebFetchHandler = (fetcher: FetchAdapter = undiciFetch as FetchAdapter, resolver: ResolveAdapter = resolveAddresses) =>
  async (args: unknown, context: ToolContext): Promise<ToolRunResult> => {
    const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
    if (typeof input.url !== "string" || !input.url.trim()) return { content: 'Error: web_fetch requires a string "url" argument.', isError: true };
    const maxChars = input.max_chars === undefined ? DEFAULT_MAX_CHARS : input.max_chars;
    if (!Number.isInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > MAX_OUTPUT_CHARS) {
      return { content: `Error: web_fetch "max_chars" must be an integer between 1 and ${MAX_OUTPUT_CHARS}.`, isError: true };
    }
    let initialUrl: URL;
    try { initialUrl = parsePublicUrl(input.url); } catch (error) { return { content: `Error: unsafe URL: ${String(error)}`, isError: true }; }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(OVERALL_TIMEOUT_MS)]);

    try {
      return formatResult(await fetchWithFallback(initialUrl, fetcher, resolver, signal), maxChars as number);
    } catch (error) {
      if (context.signal.aborted) return { content: "[stopped by user]", isError: true };
      return { content: `Web fetch failed: ${errorMessage(error)}`, isError: true };
    }
  };

registry.register({
  name: "web_fetch", toolset: "web", verb: "Fetching", previewArgKey: "url",
  schema: { name: "web_fetch", description: "Fetch readable text from a public HTTP(S) URL. Supports HTML, plain text, and JSON; private networks and binary files are blocked. Automatically falls back to the keyless Jina Reader for blocked or transiently unavailable pages.", inputSchema: {
    type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer", minimum: 1, maximum: MAX_OUTPUT_CHARS, default: DEFAULT_MAX_CHARS } }, required: ["url"],
  } }, handler: createWebFetchHandler(),
});
