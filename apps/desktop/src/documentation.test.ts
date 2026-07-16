import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [readme, architecture, currentArchitecture, desktopPlan] = await Promise.all([
  readFile(new URL("../../../README.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/adr/0001-railgun-current-architecture.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/desktop-impl-plan.md", import.meta.url), "utf8"),
]);

describe("desktop documentation", () => {
  it("explains the feedback shown during a manual update check", () => {
    expect(readme).toMatch(/A progress dialog remains visible while the\s+manual check is running\./u);
  });

  it("distinguishes scheduled job management from background automation settings", () => {
    expect(readme).toContain("Use the **Scheduled** page to create, edit, or remove prompts.");
    expect(readme).toContain("Use **Settings → General** to control background automation.");
    expect(architecture).toMatch(/The Scheduled page manages job definitions through the backend\. Settings → General\s+owns the separate Background automation control,/u);
    expect(currentArchitecture).toMatch(/Settings → General owns the\s+background-automation opt-in\./u);
    expect(desktopPlan).toMatch(/Scheduled owns persistent job definitions and Settings → General owns the\s+background-automation opt-in\./u);
  });

  it("points maintainers to the current architecture and complete verification suite", () => {
    expect(readme).toContain("[Current architecture ADR](docs/adr/0001-railgun-current-architecture.md)");
    expect(readme).toContain("pnpm run typecheck");
    expect(readme).toContain("pnpm run test");
    expect(currentArchitecture).toContain("implemented by Railgun today");
  });
});
