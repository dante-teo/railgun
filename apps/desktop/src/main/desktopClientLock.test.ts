import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopClientLock,
  DesktopClientLockConflictError,
  DesktopClientLockInvalidError,
} from "./desktopClientLock";

const directories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "railgun-desktop-lock-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DesktopClientLock", () => {
  it("creates the shared RailgunX-compatible record and releases only its own file", () => {
    const directory = temporaryDirectory();
    const lock = new DesktopClientLock({
      directory,
      pid: 4242,
      now: () => "2026-07-18T12:00:00Z",
    });

    expect(lock.acquire()).toEqual({
      pid: 4242,
      bundleId: "sh.railgun.desktop",
      clientName: "Railgun Classic",
      startTime: "2026-07-18T12:00:00Z",
    });
    expect(JSON.parse(readFileSync(lock.filePath, "utf8"))).toEqual({
      pid: 4242,
      bundleId: "sh.railgun.desktop",
      clientName: "Railgun Classic",
      startTime: "2026-07-18T12:00:00Z",
    });

    lock.release();
    expect(existsSync(lock.filePath)).toBe(false);
  });

  it("replaces a valid stale record but rejects a live owner", () => {
    const directory = temporaryDirectory();
    const staleLock = new DesktopClientLock({ directory, pid: 4242, isProcessLive: () => false });
    writeFileSync(staleLock.filePath, JSON.stringify({
      pid: 99999,
      bundleId: "io.anvia.railgun",
      clientName: "RailgunX",
      startTime: "2026-07-18T11:00:00Z",
    }));
    writeFileSync(join(directory, "desktop-client.lock.recovery"), JSON.stringify({
      pid: 99999,
      bundleId: "io.anvia.railgun",
      clientName: "RailgunX",
      startTime: "2026-07-18T11:00:00Z",
    }));

    expect(staleLock.acquire().pid).toBe(4242);
    staleLock.release();

    writeFileSync(staleLock.filePath, JSON.stringify({
      pid: 99,
      bundleId: "io.anvia.railgun",
      clientName: "RailgunX",
      startTime: "2026-07-18T11:00:00Z",
    }));
    const liveLock = new DesktopClientLock({ directory, pid: 4242, isProcessLive: pid => pid === 99 });

    expect(() => liveLock.acquire()).toThrow(DesktopClientLockConflictError);
    expect(JSON.parse(readFileSync(liveLock.filePath, "utf8"))).toMatchObject({ pid: 99, clientName: "RailgunX" });
  });

  it("does not remove a malformed record because it cannot prove it stale", () => {
    const directory = temporaryDirectory();
    const lock = new DesktopClientLock({ directory, pid: 4242 });
    writeFileSync(lock.filePath, "not JSON");

    expect(() => lock.acquire()).toThrow(DesktopClientLockInvalidError);
    expect(readFileSync(lock.filePath, "utf8")).toBe("not JSON");
  });

  it("never removes a replacement lock when releasing its own claim", () => {
    const directory = temporaryDirectory();
    const lock = new DesktopClientLock({ directory, pid: 4242, now: () => "2026-07-18T12:00:00Z" });
    const replacement = {
      pid: 99,
      bundleId: "io.anvia.railgun",
      clientName: "RailgunX",
      startTime: "2026-07-18T12:01:00Z",
    };
    lock.acquire();
    writeFileSync(lock.filePath, JSON.stringify(replacement));

    lock.release();

    expect(JSON.parse(readFileSync(lock.filePath, "utf8"))).toEqual(replacement);
  });
});
