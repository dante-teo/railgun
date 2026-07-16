import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [readme, architecture, automationDecision, desktopPlan] = await Promise.all([
  readFile(new URL("../../../README.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
  readFile(new URL("../../../docs/adr/0039-desktop-only-distribution-and-automation.md", import.meta.url), "utf8"),
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
    expect(automationDecision).toMatch(/Settings → General owns the\s+background-automation opt-in\./u);
    expect(desktopPlan).toMatch(/General includes the Background automation control for the opt-in launchd\s+services;/u);
  });
});
