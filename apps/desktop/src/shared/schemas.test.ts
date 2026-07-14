import { describe, expect, it } from "vitest";
import {
  AppCommandSchema,
  BackendSnapshotSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  MockScenarioSchema,
  TransportLogEntrySchema,
  ExternalUrlSchema,
  DesktopAgentEventSchema,
  DESKTOP_ACTIVITY_LIMITS,
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
    expect(ExternalUrlSchema.parse("https://example.com/docs")).toBe("https://example.com/docs");
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
    expect(() => ExternalUrlSchema.parse("javascript:alert(1)")).toThrow();
    expect(() => ExternalUrlSchema.parse("https://user:pass@example.com")).toThrow();
    expect(() => MockScenarioListSchema.parse({ id: "ready-idle" })).toThrow();
  });

  it("validates every agent activity variant strictly", () => {
    const events = [
      { type: "tool-start", id: "call-1", name: "read_file", input: "{}" },
      { type: "tool-end", id: "call-1", name: "read_file", failed: false, output: "ok", todos: [{ id: "a", content: "Ship", status: "completed" }] },
      { type: "moa-reference-start", index: 0, count: 2, model: "ref" },
      { type: "moa-reference-end", index: 0, model: "ref", preview: "idea" },
      { type: "moa-aggregating", model: "agg", refCount: 2 },
      { type: "advisor-note", severity: "concern", text: "Check this" },
      { type: "subagent-start", index: 0, count: 1, goal: "Inspect" },
      { type: "subagent-end", index: 0, goal: "Inspect", result: "Done" },
    ] as const;
    expect(events.map(event => DesktopAgentEventSchema.parse(event))).toEqual(events);
    expect(() => DesktopAgentEventSchema.parse({ ...events[5], severity: "critical" })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[0], args: { secret: true } })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[0], input: "x".repeat(DESKTOP_ACTIVITY_LIMITS.detail + 1) })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[5], text: "x".repeat(DESKTOP_ACTIVITY_LIMITS.content + 1) })).toThrow();
  });
});
