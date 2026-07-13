import { describe, expect, it } from "vitest";
import { resolveRendererAsset } from "./rendererProtocol";

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
});
