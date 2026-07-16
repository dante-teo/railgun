import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [readme, architecture, currentArchitecture, swiftPlan] = await Promise.all([
  readFile(new URL("../../../README.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/adr/0001-railgun-current-architecture.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/swift-plan.md", import.meta.url), "utf8"),
]);
const normalizedSwiftPlan = swiftPlan.replaceAll(/\s+/gu, " ");

describe("desktop documentation", () => {
  it("explains the feedback shown during a manual update check", () => {
    expect(readme).toMatch(/A progress dialog remains visible while the\s+manual check is running\./u);
  });

  it("distinguishes scheduled job management from background automation settings", () => {
    expect(readme).toContain("Use the **Scheduled** page to create, edit, or remove prompts.");
    expect(readme).toContain("Use **Settings → General** to control background automation.");
    expect(architecture).toMatch(/The Scheduled page manages job definitions through the backend\. Settings → General\s+owns the separate Background automation control,/u);
    expect(currentArchitecture).toMatch(/Settings → General owns the\s+background-automation opt-in\./u);
    expect(swiftPlan).toMatch(/Scheduled owns persistent job definitions, while Settings → Background Automation owns\s+the opt-in and launch-agent controls\./u);
  });

  it("points maintainers to the current architecture and complete verification suite", () => {
    expect(readme).toContain("[Current architecture ADR](docs/adr/0001-railgun-current-architecture.md)");
    expect(readme).toContain("pnpm run typecheck");
    expect(readme).toContain("pnpm run test");
    expect(currentArchitecture).toContain("implemented by Railgun today");
  });

  it("documents the native client naming and shared-data contract", () => {
    expect(readme).toContain("[Swift implementation plan](docs/swift-plan.md)");
    expect(normalizedSwiftPlan).toContain("**RailgunX** with bundle ID `io.anvia.railgun`");
    expect(normalizedSwiftPlan).toContain("Electron becomes **Railgun Classic**");
    expect(normalizedSwiftPlan).toContain("Classic keeps its existing `sh.railgun.desktop` identity");
    expect(normalizedSwiftPlan).toContain("Both clients use `~/.railgun` in place");
    expect(normalizedSwiftPlan).toContain("PID, bundle ID, client name, and start time");
  });

  it("records the reproducible Swift toolchain decisions", () => {
    expect(normalizedSwiftPlan).toContain("Swift 6 and SwiftUI");
    expect(normalizedSwiftPlan).toContain("`apps/macos/project.yml`");
    expect(normalizedSwiftPlan).toContain("Generated `.xcodeproj` files are disposable");
    expect(normalizedSwiftPlan).toContain("Swift Package Manager with exact dependency versions committed in `Package.resolved`");
    expect(normalizedSwiftPlan).toContain("Build with the macOS 26 SDK and deploy to macOS 15");
  });

  it("makes native SwiftUI the default and centralizes justified custom UI", () => {
    expect(normalizedSwiftPlan).toContain("Start with native SwiftUI components");
    expect(normalizedSwiftPlan).toContain("Do not recreate system controls, menus, dialogs, sidebars, toolbars, forms, or materials with custom drawing.");
    expect(normalizedSwiftPlan).toContain("Use AppKit bridges only for behavior unavailable in deployment-target SwiftUI.");
    expect(normalizedSwiftPlan).toContain("Place reusable custom UI in the dedicated `RailgunUI` target");
    expect(normalizedSwiftPlan).toContain("Each interactive custom component requires keyboard, focus, VoiceOver, accessible-name, and state tests.");
  });

  it("preserves the new icon through the final rename", () => {
    expect(normalizedSwiftPlan).toContain("The new native app-icon system remains in use when RailgunX becomes Railgun.");
    expect(normalizedSwiftPlan).toContain("Icon acceptance covers generated sizes, light and dark appearance, Finder, Dock, Launchpad, About, notifications, and updates.");
  });

  it("uses immutable, bounded implementation task IDs", () => {
    expect(normalizedSwiftPlan).toContain("Completed or removed IDs are never reused or renumbered.");
    expect(normalizedSwiftPlan).toContain("New work receives a new ID.");

    const tasks = [...swiftPlan.matchAll(/^- \[ \] `(SWFT-\d{3})` — .* `\[(\d+)h\]`$/gmu)];
    const taskIds = tasks.map(([, id]) => id);
    const estimates = tasks.map(([, , estimate]) => Number(estimate));

    expect(tasks).toHaveLength(83);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(new Set(taskIds)).toEqual(
      new Set(Array.from({ length: 83 }, (_, index) => `SWFT-${String(index + 1).padStart(3, "0")}`)),
    );
    expect(estimates.every((estimate) => estimate <= 8)).toBe(true);
  });
});
