import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package runtime compatibility", () => {
  it("declares the minimum Node version required by runtime dependencies", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      engines?: { node?: string };
    };
    expect(packageJson.engines?.node).toBe(">=22.19.0");
  });
});
