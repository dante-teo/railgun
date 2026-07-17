import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const desktopCiWorkflow = ciWorkflow.slice(ciWorkflow.indexOf("  desktop:"));
const releaseGuide = readFileSync(new URL("../docs/RELEASING.md", import.meta.url), "utf8");
const electronInstallAction = () => readFileSync(new URL("../.github/actions/install-electron/action.yml", import.meta.url), "utf8");

describe("desktop release artifacts", () => {
  it("releases desktop builds from standard semantic version tags", () => {
    expect(workflow).toContain('      - "v*"');
    expect(workflow).not.toContain('      - "desktop-v*"');
  });

  it("retains darwin architecture identifiers for direct updater archives", () => {
    expect(workflow).toContain('destination="$RUNNER_TEMP/Railgun-direct-${version}-darwin-${{ matrix.arch }}.zip"');
  });

  it("installs Electron with a shared retried action before desktop builds", () => {
    [workflow, desktopCiWorkflow].forEach((desktopWorkflow) => {
      expect(desktopWorkflow).toContain("- name: Install Electron binary");
      expect(desktopWorkflow).toContain("uses: ./.github/actions/install-electron");
    });

    const action = electronInstallAction();
    expect(action).toContain('pnpm --filter @dantea/railgun-desktop exec install-electron --no');
    expect(action).toContain('max_attempts=3');
  });

  it("documents Electron prefetch retries for release operators", () => {
    expect(releaseGuide).toMatch(/prefetches the Electron\s+binary with up to three attempts/u);
  });
});
