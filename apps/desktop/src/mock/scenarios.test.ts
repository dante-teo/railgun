import { describe, expect, it } from "vitest";
import { defineMockScenarios, getMockScenario, listMockScenarios } from "./scenarios";

describe("mock scenario registry", () => {
  it("lists every initial scenario without exposing behavior controls", () => {
    expect(listMockScenarios().map((scenario) => scenario.id)).toEqual([
      "ready-idle",
      "delayed-startup",
      "command-rejection",
      "malformed-output",
      "crash-before-ready",
      "disconnect-after-ready",
    ]);
    expect(listMockScenarios()[0]).not.toHaveProperty("behavior");
  });

  it("rejects unknown and duplicate scenario ids", () => {
    expect(() => getMockScenario("missing")).toThrow("Unknown mock scenario: missing");
    expect(() => defineMockScenarios([
      { id: "ready-idle", label: "First", description: "First", behavior: "ready" },
      { id: "ready-idle", label: "Second", description: "Second", behavior: "ready" },
    ])).toThrow("Duplicate mock scenario id: ready-idle");
  });
});
