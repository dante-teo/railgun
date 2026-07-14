import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initializeLogFile, pruneInteractiveLogs } from "./storage.js";

const homes: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("interactive diagnostic storage", () => {
  it("creates private per-run logs and atomically points the stable path at the run", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-diagnostics-"));
    homes.push(home);
    const opened = await initializeLogFile({ logDir: join(home, "logs"), runId: "run-id", pid: 42, now: new Date("2026-07-14T01:02:03.000Z") });
    await opened.handle.writeFile('{"event":"test"}\n');
    await opened.handle.close();

    expect((await stat(join(home, "logs"))).mode & 0o777).toBe(0o700);
    expect((await stat(opened.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(opened.latestPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(opened.latestPath, "utf8")).toBe('{"event":"test"}\n');
    expect(basename(opened.path)).toMatch(/^interactive-20260714T010203000Z-42-run-id\.jsonl$/);
  });

  it("prunes expired logs and enforces the total cap oldest-first", async () => {
    const home = await mkdtemp(join(tmpdir(), "railgun-diagnostics-"));
    homes.push(home);
    const logDir = join(home, "logs");
    await mkdir(logDir, { recursive: true });
    const files = ["interactive-old.jsonl", "interactive-first.jsonl", "interactive-new.jsonl"];
    await Promise.all(files.map(file => writeFile(join(logDir, file), "x".repeat(60))));
    await chmod(logDir, 0o700);
    await utimes(join(logDir, files[0]!), new Date("2026-07-01"), new Date("2026-07-01"));
    await utimes(join(logDir, files[1]!), new Date("2026-07-13T00:00:00Z"), new Date("2026-07-13T00:00:00Z"));
    await utimes(join(logDir, files[2]!), new Date("2026-07-13T01:00:00Z"), new Date("2026-07-13T01:00:00Z"));

    await pruneInteractiveLogs(logDir, { nowMs: new Date("2026-07-14").getTime(), retentionMs: 7 * 86_400_000, maxBytes: 60 });

    await expect(stat(join(logDir, files[0]!))).rejects.toThrow();
    await expect(stat(join(logDir, files[1]!))).rejects.toThrow();
    expect((await stat(join(logDir, files[2]!))).size).toBe(60);
  });
});
