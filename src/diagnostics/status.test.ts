import { describe, expect, it } from "vitest";
import { formatElapsed, reduceDiagnosticStatus, statusText } from "./status.js";

describe("interactive diagnostic status", () => {
  it("formats elapsed time compactly", () => {
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_665_000)).toBe("1h 01m");
  });

  it("combines parallel tools and restores the parent phase", () => {
    const ready = reduceDiagnosticStatus(undefined, { type: "ready", at: 0 });
    const provider = reduceDiagnosticStatus(ready, { type: "start", operationId: "turn", phase: "provider_stream", at: 100 });
    const first = reduceDiagnosticStatus(provider, { type: "start", operationId: "tool-1", phase: "tool", toolName: "read_file", at: 200 });
    const second = reduceDiagnosticStatus(first, { type: "start", operationId: "tool-2", phase: "tool", toolName: "web_search", at: 300 });
    expect(statusText(second, 1_300)).toBe("tools (2) · 1s");
    expect(statusText(reduceDiagnosticStatus(second, { type: "end", operationId: "tool-2", at: 1_400 }), 1_500)).toBe("tool: read_file · 1s");
  });

  it("starts elapsed time at the first operation after an idle period", () => {
    const idle = reduceDiagnosticStatus(undefined, { type: "ready", at: 0 });
    const working = reduceDiagnosticStatus(idle, { type: "start", operationId: "turn", phase: "agent_turn", at: 300_000 });
    expect(statusText(working, 301_000)).toBe("agent turn · 1s");
  });

  it("renders prominent stall and unavailable states with the stable path", () => {
    const stalled = reduceDiagnosticStatus(undefined, { type: "stall", kind: "operation", at: 30_000, latestLogPath: "/home/u/.railgun/logs/interactive-latest.jsonl" });
    expect(statusText(stalled, 31_000)).toContain("STALLED");
    expect(statusText(stalled, 31_000)).toContain("interactive-latest.jsonl");
    expect(statusText(reduceDiagnosticStatus(stalled, { type: "unavailable", at: 32_000 }), 32_000)).toBe("logs unavailable");
  });
});
