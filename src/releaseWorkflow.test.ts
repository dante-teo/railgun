import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

describe("desktop release artifacts", () => {
  it("releases desktop builds from standard semantic version tags", () => {
    expect(workflow).toContain('      - "v*"');
    expect(workflow).not.toContain('      - "desktop-v*"');
  });

  it("retains darwin architecture identifiers for direct updater archives", () => {
    expect(workflow).toContain('destination="$RUNNER_TEMP/Railgun-${{ matrix.channel }}-${version}-darwin-${{ matrix.arch }}.zip"');
  });
});
