import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveDiagnostics, createNoopInteractiveDiagnostics, createUnavailableInteractiveDiagnostics } from "./interactiveDiagnostics.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("no-op interactive diagnostics", () => {
  it("is immutable, side-effect free, and preserves observer call sites", async () => {
    const diagnostics = createNoopInteractiveDiagnostics();
    const listener = vi.fn();
    const unsubscribe = diagnostics.subscribe(listener);
    const operation = diagnostics.observer.start({ phase: "provider_stream", model: "secret-model" });
    operation.progress({ messageBytes: 12 });
    operation.end("success");
    diagnostics.observer.event({ event: "ignored" });
    unsubscribe();
    await diagnostics.close();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(diagnostics.status.kind).toBe("ready");
    expect(listener).not.toHaveBeenCalled();
  });

  it("provides an immutable unavailable fallback without side effects", async () => {
    const diagnostics = createUnavailableInteractiveDiagnostics();
    diagnostics.observer.event({ event: "ignored" });
    await diagnostics.close();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(diagnostics.status.kind).toBe("unavailable");
  });
});

describe("interactive diagnostics worker", () => {
  it("flushes valid records in order and updates the stable log", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-diagnostics-worker-"));
    temporaryDirectories.push(home);
    const diagnostics = createInteractiveDiagnostics({ logDir: join(home, "logs"), runId: "worker-test" });
    const operation = diagnostics.observer.start({ operationId: "op-1", phase: "provider_stream", model: "model-a" });
    operation.progress({ progressCount: 2, messageBytes: 20 });
    operation.end("success");
    await diagnostics.close();

    const records = (await readFile(join(home, "logs", "interactive-latest.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "diagnostics_start",
      "operation_start",
      "operation_progress",
      "operation_success",
      "diagnostics_shutdown",
    ]);
  });
});
