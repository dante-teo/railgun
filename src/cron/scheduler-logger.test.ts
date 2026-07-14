/**
 * Tests for cronLogPath and cleanOldLogs.
 * Both are safe with real fs: cronLogPath is pure, cleanOldLogs takes an
 * explicit logsDir parameter and never touches CRON_LOGS_PATH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronLogPath, cleanOldLogs } from "./scheduler.js";

// ---------------------------------------------------------------------------
// cronLogPath
// ---------------------------------------------------------------------------

describe("cronLogPath", () => {
  it("returns a path ending in cron/logs/cron-YYYY-MM-DD.log", () => {
    const p = cronLogPath(new Date("2026-07-14T10:00:00.000Z"));
    expect(p).toMatch(/cron[/\\]logs[/\\]cron-2026-07-14\.log$/);
  });

  it("produces distinct paths for distinct UTC calendar days", () => {
    const a = cronLogPath(new Date("2026-01-01T00:00:00.000Z"));
    const b = cronLogPath(new Date("2026-01-02T00:00:00.000Z"));
    expect(a).toMatch(/cron-2026-01-01\.log$/);
    expect(b).toMatch(/cron-2026-01-02\.log$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// cleanOldLogs
// ---------------------------------------------------------------------------

describe("cleanOldLogs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "railgun-clean-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes log files older than maxAgeDays", () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldName = `cron-${oldDate.toISOString().slice(0, 10)}.log`;
    writeFileSync(join(tmpDir, oldName), "old");
    cleanOldLogs(tmpDir, 7);
    expect(existsSync(join(tmpDir, oldName))).toBe(false);
  });

  it("keeps log files within maxAgeDays", () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const recentName = `cron-${recentDate.toISOString().slice(0, 10)}.log`;
    writeFileSync(join(tmpDir, recentName), "recent");
    cleanOldLogs(tmpDir, 7);
    expect(existsSync(join(tmpDir, recentName))).toBe(true);
  });

  it("ignores files that do not match the cron log filename pattern", () => {
    writeFileSync(join(tmpDir, "other-file.log"), "other");
    cleanOldLogs(tmpDir, 7);
    expect(existsSync(join(tmpDir, "other-file.log"))).toBe(true);
  });

  it("does not throw when the logs directory does not exist", () => {
    expect(() => cleanOldLogs(join(tmpDir, "nonexistent"), 7)).not.toThrow();
  });

  it("deletes only files beyond the cutoff, keeps the rest", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const oldName = `cron-${oldDate.toISOString().slice(0, 10)}.log`;
    const recentName = `cron-${recentDate.toISOString().slice(0, 10)}.log`;
    writeFileSync(join(tmpDir, oldName), "old");
    writeFileSync(join(tmpDir, recentName), "recent");
    cleanOldLogs(tmpDir, 7);
    expect(existsSync(join(tmpDir, oldName))).toBe(false);
    expect(existsSync(join(tmpDir, recentName))).toBe(true);
  });

  it("keeps a file dated exactly maxAgeDays ago (boundary), deletes one day older — frozen at 2026-07-14T15:00Z", () => {
    // Freeze time mid-day to prove the cutoff is calendar-day UTC, not wall-clock offset.
    // today = 2026-07-14 → cutoff midnight = 2026-07-07T00:00Z
    // cron-2026-07-07.log (midnight of cutoff day) → kept (equal to cutoff, not older)
    // cron-2026-07-06.log (one day before cutoff)  → deleted
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T15:00:00.000Z"));
    try {
      writeFileSync(join(tmpDir, "cron-2026-07-07.log"), "boundary");
      writeFileSync(join(tmpDir, "cron-2026-07-06.log"), "too-old");
      cleanOldLogs(tmpDir, 7);
      expect(existsSync(join(tmpDir, "cron-2026-07-07.log"))).toBe(true);
      expect(existsSync(join(tmpDir, "cron-2026-07-06.log"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onError for non-ENOENT readdirSync failures (e.g. logsDir is a file)", () => {
    const filePath = join(tmpDir, "not-a-dir.log");
    writeFileSync(filePath, "i am a file");
    const onError = vi.fn();
    cleanOldLogs(filePath, 7, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatch(/Failed to read log directory/);
  });

  it("does not call onError when the directory does not exist (ENOENT is expected)", () => {
    const onError = vi.fn();
    cleanOldLogs(join(tmpDir, "nonexistent"), 7, onError);
    expect(onError).not.toHaveBeenCalled();
  });
});
