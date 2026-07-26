import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  readonly engines?: { readonly node?: string };
  readonly scripts?: Readonly<Record<string, string>>;
}

const packageMetadata = (): PackageMetadata => JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

describe("package metadata", () => {
  it("declares the minimum Node version required by runtime dependencies", () => {
    expect(packageMetadata().engines?.node).toBe(">=22.19.0");
  });

  it("launches the native app from source and mock modes and provides the native version pump", () => {
    expect(packageMetadata().scripts?.dev).toBe("./scripts/run-source.sh");
    expect(packageMetadata().scripts?.["dev:mock"]).toBe("./scripts/run-mock.sh");
    expect(packageMetadata().scripts?.["release:version"]).toBe("node ./scripts/release-version.mjs");
  });
});
