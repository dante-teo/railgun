import { describe, expect, it } from "vitest";
import { diagnosticSlashPhase } from "./slashCommand.js";

describe("slash command diagnostics", () => {
  it.each([
    ["/compact", "slash_compact"],
    ["/dream", "slash_dream"],
    ["/branch", "slash_branch"],
    ["/skill:private-skill-name", "slash_skill"],
    ["/token=secret-value", "slash_unknown"],
  ])("maps %s to the fixed phase %s", (command, expected) => {
    expect(diagnosticSlashPhase(command)).toBe(expected);
  });

  it("never copies unknown or skill tokens into the phase", () => {
    expect(JSON.stringify([
      diagnosticSlashPhase("/token=secret-value"),
      diagnosticSlashPhase("/skill:private-skill-name"),
    ])).not.toContain("secret-value");
  });
});
