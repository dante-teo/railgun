import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRendererProtocolHandler, resolveRendererAsset } from "./rendererProtocol";

describe("railgun renderer protocol routing", () => {
  const root = "/Applications/Railgun.app/Contents/Resources/app.asar/.vite/renderer/main_window";

  it("routes root and bundled assets for safe methods", () => {
    expect(resolveRendererAsset(root, "railgun://app/", "GET")).toEqual({
      method: "GET",
      path: `${root}/index.html`,
    });
    expect(resolveRendererAsset(root, "railgun://app/assets/main.js?v=1", "head")).toEqual({
      method: "HEAD",
      path: `${root}/assets/main.js`,
    });
  });

  it.each([
    ["https://app/index.html", "GET"],
    ["railgun://foreign/index.html", "GET"],
    ["railgun://app/index.html", "POST"],
    ["railgun://user@app/index.html", "GET"],
    ["railgun://app/%2e%2e/secret", "GET"],
    ["railgun://app/../secret", "GET"],
    ["railgun://app/assets/%2E%2E/secret", "GET"],
    ["railgun://app/assets%2f..%2fsecret", "GET"],
    ["railgun://app/%E0%A4%A", "GET"],
    ["not a url", "GET"],
  ])("rejects unsafe request %s %s", (url, method) => {
    expect(resolveRendererAsset(root, url, method)).toBeUndefined();
  });

  it.each([
    ["barlow.woff2", "font/woff2"],
    ["departure-mono.otf", "font/otf"],
  ])("serves %s with its font MIME type", async (fileName, contentType) => {
    const rendererRoot = await mkdtemp(join(tmpdir(), "railgun-renderer-"));
    try {
      await writeFile(join(rendererRoot, fileName), new Uint8Array([0, 1, 2]));
      const response = await createRendererProtocolHandler(rendererRoot)(
        new Request(`railgun://app/${fileName}`),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(contentType);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    } finally {
      await rm(rendererRoot, { force: true, recursive: true });
    }
  });
});
