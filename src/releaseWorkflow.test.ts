import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const desktopCiWorkflow = ciWorkflow.slice(ciWorkflow.indexOf("  desktop:"));
const electronInstallAction = () => readFileSync(new URL("../.github/actions/install-electron/action.yml", import.meta.url), "utf8");

describe("desktop release artifacts", () => {
  it("releases desktop builds from standard semantic version tags", () => {
    expect(workflow).toContain('      - "v*"');
    expect(workflow).not.toContain('      - "desktop-v*"');
  });

  it("publishes arm64 direct updater archives only", () => {
    expect(workflow).toContain('destination="$RUNNER_TEMP/Railgun-direct-${version}-darwin-arm64.zip"');
    expect(workflow).toContain('railgun_arm64_zip="dist/Railgun-${version}-darwin-arm64.zip"');
    expect(workflow).toContain('railgun_arm64_appcast="dist/Railgun-appcast-arm64.xml"');
    expect(workflow).not.toContain("macos-15-intel");
    expect(workflow).not.toContain("darwin-x64");
    expect(workflow).not.toContain("x86_64");
    expect(workflow).not.toContain("matrix.arch");
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
});
