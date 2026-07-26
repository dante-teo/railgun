import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("native release artifacts", () => {
  it("releases native builds from standard semantic version tags", () => {
    expect(workflow).toContain('      - "v*"');
    expect(workflow).not.toContain('      - "desktop-v*"');
  });

  it("publishes arm64 Sparkle archives only", () => {
    expect(workflow).toContain('Railgun-${{ steps.metadata.outputs.version }}-darwin-arm64.zip');
    expect(workflow).toContain('Railgun-appcast-arm64.xml');
    expect(workflow).not.toContain("macos-15-intel");
    expect(workflow).not.toContain("darwin-x64");
    expect(workflow).not.toContain("x86_64");
    expect(workflow).not.toContain("matrix.arch");
  });

  it("contains no Electron release or CI job", () => {
    expect(workflow).not.toMatch(/electron|desktop/i);
    expect(ciWorkflow).not.toMatch(/electron|railgun-desktop/i);
  });
});
