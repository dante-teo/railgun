import { describe, expect, it } from "vitest";
import { createDiagnosticRecord, redactErrorMessage } from "./schema.js";

describe("interactive diagnostic schema", () => {
  it("redacts secrets, paths, and truncates defensive error summaries", () => {
    const result = redactErrorMessage(`Bearer secret-token password=hunter2 at /Users/alice/private/file.ts Command failed: rm -rf ~/.ssh ${"x".repeat(800)}`);
    expect(result).not.toContain("secret-token");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("rm -rf");
    expect(result.length).toBeLessThanOrEqual(512);
  });

  it("only includes explicitly safe fields", () => {
    const record = createDiagnosticRecord({
      event: "operation_failure",
      severity: "error",
      runId: "run-1",
      sessionId: "session-1",
      operationId: "operation-1",
      phase: "provider_stream",
      durationMs: 42,
      outcome: "failure",
      model: "model-a",
      toolName: "read_file",
      errorClass: "TypeError",
      errorMessage: "token=private",
      terminalColumns: 120,
      terminalRows: 40,
      // Deliberately hostile extras must never cross the schema boundary.
      prompt: "private prompt",
      args: { command: "rm -rf" },
    } as never, { now: () => new Date("2026-07-14T00:00:00.000Z"), pid: 123 });

    expect(record).toMatchObject({
      timestamp: "2026-07-14T00:00:00.000Z",
      event: "operation_failure",
      process: { pid: 123, platform: process.platform, node: process.version },
    });
    expect(JSON.stringify(record)).not.toContain("private prompt");
    expect(JSON.stringify(record)).not.toContain("rm -rf");
    expect(record.errorMessage).toBe("token=[REDACTED]");
  });
});
