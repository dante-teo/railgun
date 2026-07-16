import { describe, expect, it, vi } from "vitest";
import { createPinnedLookup, createWebFetchHandler, isPublicAddress } from "./webFetch.js";

const context = (signal = new AbortController().signal) => ({
  signal, commandApprovalMode: "off" as const, sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => true,
});
const resolvePublic = vi.fn().mockResolvedValue(["93.184.216.34"]);
const response = (body: string, contentType: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": contentType, ...headers } });

describe("web_fetch", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1"])("rejects non-public address %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("accepts public IPv4 and IPv6", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("returns an address array when Node requests all DNS results", async () => {
    const lookup = createPinnedLookup("93.184.216.34");
    const addresses = await new Promise((resolve, reject) => lookup("example.com", { all: true }, (error, result) => {
      if (error) reject(error); else resolve(result);
    }));
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
  it("fetches a bracketed public IPv6 literal without DNS lookup", async () => {
    const fetcher = vi.fn().mockResolvedValue(response("public ipv6", "text/plain"));
    const resolver = vi.fn().mockRejectedValue(new Error("IPv6 literals must not use DNS"));
    const result = await createWebFetchHandler(fetcher, resolver)({ url: "http://[2606:4700:4700::1111]/" }, context());
    expect(result.isError).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith("http://[2606:4700:4700::1111]/", expect.anything());
  });
  it.each(["file:///tmp/a", "http://user:pass@example.com", "http://127.0.0.1", "http://0x7f000001"])("rejects unsafe URL %s", async url => {
    const result = await createWebFetchHandler(vi.fn(), resolvePublic)({ url }, context());
    expect(result.isError).toBe(true);
  });
  it("extracts readable HTML and metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(response("<html><head><title>Page</title></head><body><article><h1>Hello</h1><p>This is useful article text.</p></article></body></html>", "text/html"));
    const result = await createWebFetchHandler(fetcher, resolvePublic)({ url: "https://example.com" }, context());
    const value = JSON.parse(result.content);
    expect(value).toMatchObject({ final_url: "https://example.com/", title: "Page", content_type: "text/html" });
    expect(value.content).toContain("useful article text");
  });
  it("falls back to the keyless Jina reader when the direct request is blocked", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response("blocked", "text/plain", 403))
      .mockResolvedValueOnce(response("# Useful fallback content", "text/plain"));
    const result = await createWebFetchHandler(fetcher, resolvePublic)({ url: "https://example.com/article" }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      final_url: "https://example.com/article",
      content: "# Useful fallback content",
      reader: "jina",
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://r.jina.ai/https://example.com/article", expect.objectContaining({
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    }));
  });
  it("tries another validated address before using the reader fallback", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response("second address worked", "text/plain"));
    const resolver = vi.fn().mockResolvedValue(["2606:4700:4700::1111", "93.184.216.34"]);
    const result = await createWebFetchHandler(fetcher, resolver)({ url: "https://example.com" }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ content: "second address worked" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://example.com/", "https://example.com/"]);
  });
  it("uses the reader fallback for an HTML bot challenge", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response("<html><body>Enable JavaScript to continue</body></html>", "text/html"))
      .mockResolvedValueOnce(response("Rendered article", "text/plain"));
    const result = await createWebFetchHandler(fetcher, resolvePublic)({ url: "https://example.com" }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ content: "Rendered article", reader: "jina" });
  });
  it("reports the underlying transport causes when both fetch paths fail", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("socket reset") }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("network unreachable") }));
    const result = await createWebFetchHandler(fetcher, resolvePublic)({ url: "https://example.com" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("socket reset");
    expect(result.content).toContain("network unreachable");
  });
  it("supports text and JSON, truncates output, and rejects binary content", async () => {
    const textResult = await createWebFetchHandler(vi.fn().mockResolvedValue(response("abcdefgh", "text/plain")), resolvePublic)({ url: "https://example.com", max_chars: 5 }, context());
    expect(JSON.parse(textResult.content)).toMatchObject({ content: "abcde", truncated: true });
    const jsonResult = await createWebFetchHandler(vi.fn().mockResolvedValue(response('{"ok":true}', "application/json")), resolvePublic)({ url: "https://example.com" }, context());
    expect(JSON.parse(jsonResult.content).content).toContain('"ok": true');
    const binary = await createWebFetchHandler(vi.fn().mockResolvedValue(response("pdf", "application/pdf")), resolvePublic)({ url: "https://example.com/a.pdf" }, context());
    expect(binary.content).toMatch(/unsupported content type/i);
  });
  it("revalidates redirects and rejects redirects to private hosts", async () => {
    const fetcher = vi.fn().mockResolvedValue(response("", "text/plain", 302, { location: "http://localhost/secret" }));
    const result = await createWebFetchHandler(fetcher, resolvePublic)({ url: "https://example.com" }, context());
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
