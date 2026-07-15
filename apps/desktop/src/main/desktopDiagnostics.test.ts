import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopDiagnosticSink } from "./desktopDiagnostics";

describe("desktop diagnostic persistence", () => {
  it("creates private per-launch JSONL and replaces the latest link", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-desktop-log-"));
    const first = createDesktopDiagnosticSink({ home, now: () => new Date("2026-07-15T01:02:03.000Z"), pid: 10 });
    first.write({ category: "transport", direction: "stdout", text: "type=response" });
    const second = createDesktopDiagnosticSink({ home, now: () => new Date("2026-07-15T01:03:03.000Z"), pid: 11 });
    second.write({ category: "lifecycle", direction: "system", text: "Starting backend" });
    const directory = join(home, ".railgun", "logs");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(second.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, "desktop-latest.jsonl"), "utf8")).toContain("Starting backend");
    expect(JSON.parse(readFileSync(first.path, "utf8").trim())).toMatchObject({ category: "transport", text: "type=response" });
  });

  it("prunes expired and oversized prior launch files but retains the active file", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-desktop-prune-"));
    const directory = join(home, ".railgun", "logs");
    mkdirSync(directory, { recursive: true });
    const old = join(directory, "desktop-2020-01-01T00-00-00.000Z-1.jsonl");
    writeFileSync(old, "x".repeat(200));
    chmodSync(old, 0o600);
    utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"));
    const sink = createDesktopDiagnosticSink({ home, now: () => new Date("2026-07-15T00:00:00.000Z"), pid: 2, maxAggregateBytes: 100 });
    expect(() => statSync(old)).toThrow();
    expect(statSync(sink.path).isFile()).toBe(true);
  });

  it("prunes an older recent launch to reserve space for the current record", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-desktop-capacity-"));
    const directory = join(home, ".railgun", "logs");
    mkdirSync(directory, { recursive: true });
    const prior = join(directory, "desktop-2026-07-15T00-00-00.000Z-1.jsonl");
    writeFileSync(prior, "x".repeat(350));
    const observedAt = new Date("2026-07-15T01:00:00.000Z");
    utimesSync(prior, observedAt, observedAt);
    const sink = createDesktopDiagnosticSink({ home, now: () => observedAt, pid: 2, maxAggregateBytes: 400 });

    sink.write({ category: "transport", direction: "stdout", text: "current record" });

    expect(() => statSync(prior)).toThrow();
    expect(readFileSync(sink.path, "utf8")).toContain("current record");
  });

  it("falls back to a no-op sink when diagnostics storage cannot be initialized", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-desktop-unavailable-"));
    writeFileSync(join(home, ".railgun"), "not a directory");

    const sink = createDesktopDiagnosticSink({ home });

    expect(sink.path).toBe("");
    expect(() => sink.write({ category: "lifecycle", text: "ignored" })).not.toThrow();
  });
});
