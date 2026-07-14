/**
 * Tests for createCronLogger.
 *
 * All write-side node:fs calls are pure vi.fn() stubs — no call-through —
 * so no path under CRON_LOGS_PATH (or anywhere else) is touched at runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(), // pure stub: no call-through, never touches real paths
  };
});

import * as nodeFs from "node:fs";
import { createCronLogger } from "./scheduler.js";

const mkdirSyncMock    = vi.mocked(nodeFs.mkdirSync);
const appendFileMock   = vi.mocked(nodeFs.appendFileSync);
const symlinkMock      = vi.mocked(nodeFs.symlinkSync);
const unlinkMock       = vi.mocked(nodeFs.unlinkSync);

beforeEach(() => {
  mkdirSyncMock.mockReset();
  appendFileMock.mockReset();
  symlinkMock.mockReset();
  unlinkMock.mockReset();
});

describe("createCronLogger", () => {
  it("calls mkdirSync with recursive:true on first write", () => {
    const log = createCronLogger();
    log("hello");
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("appends an ISO-timestamped line to today's log file", () => {
    const log = createCronLogger();
    log("hello world");
    expect(appendFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/cron-\d{4}-\d{2}-\d{2}\.log$/),
      expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello world\n$/),
    );
  });

  it("creates the cron-latest.log symlink on first write", () => {
    const log = createCronLogger();
    log("first");
    expect(symlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/cron-\d{4}-\d{2}-\d{2}\.log$/),
      expect.stringContaining("cron-latest.log"),
    );
  });

  it("removes stale symlink before creating new one (unlinkSync before symlinkSync)", () => {
    const log = createCronLogger();
    log("first");
    const unlinkOrder  = unlinkMock.mock.invocationCallOrder[0]!;
    const symlinkOrder = symlinkMock.mock.invocationCallOrder[0]!;
    expect(unlinkOrder).toBeLessThan(symlinkOrder);
  });

  it("only creates the symlink once when the date does not change", () => {
    const log = createCronLogger();
    log("a");
    log("b");
    log("c");
    expect(symlinkMock).toHaveBeenCalledTimes(1);
  });

  it("appends each call as a separate appendFileSync invocation", () => {
    const log = createCronLogger();
    log("one");
    log("two");
    expect(appendFileMock).toHaveBeenCalledTimes(2);
  });
});
