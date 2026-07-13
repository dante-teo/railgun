import { describe, expect, it } from "vitest";
import {
  AppCommandSchema,
  BackendSnapshotSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  MockScenarioSchema,
  TransportLogEntrySchema,
} from "./schemas";

const validSnapshot = {
  mode: "mock",
  phase: "ready",
  scenarioId: "ready-idle",
  diagnostics: [],
  transportLog: [{ direction: "system", text: "ready" }],
} as const;

describe("desktop boundary schemas", () => {
  it("accepts valid snapshots, entries, scenarios, and ids", () => {
    expect(AppCommandSchema.parse("command-palette")).toBe("command-palette");
    expect(BackendSnapshotSchema.parse(validSnapshot)).toEqual(validSnapshot);
    expect(TransportLogEntrySchema.parse(validSnapshot.transportLog[0])).toEqual(validSnapshot.transportLog[0]);
    expect(MockScenarioIdSchema.parse("ready-idle")).toBe("ready-idle");
    expect(BackendSnapshotSchema.parse({ ...validSnapshot, phase: "authentication-required" }).phase)
      .toBe("authentication-required");
    expect(MockScenarioSchema.parse({ id: "ready-idle", label: "Ready", description: "Ready now" })).toBeTruthy();
    expect(MockScenarioListSchema.parse([{ id: "ready-idle", label: "Ready", description: "Ready now" }])).toHaveLength(1);
  });

  it("rejects unknown fields at every object boundary", () => {
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, electron: {} })).toThrow();
    expect(() => TransportLogEntrySchema.parse({ ...validSnapshot.transportLog[0], extra: true })).toThrow();
    expect(() => MockScenarioSchema.parse({ id: "ready-idle", label: "Ready", description: "Ready", behavior: "crash" })).toThrow();
  });

  it("rejects wrong discriminants, malformed arrays, and invalid ids", () => {
    expect(() => AppCommandSchema.parse("open-terminal")).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, phase: "loading" })).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, diagnostics: "none" })).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, transportLog: [null] })).toThrow();
    expect(() => TransportLogEntrySchema.parse({ direction: "network", text: "bad" })).toThrow();
    expect(() => MockScenarioIdSchema.parse("../../escape")).toThrow();
    expect(() => MockScenarioListSchema.parse({ id: "ready-idle" })).toThrow();
  });
});
