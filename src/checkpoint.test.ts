import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { shadowGitDir, snapshot, rollback, createCheckpointGuard } from "./checkpoint.js";
import { getHomeDir } from "./paths.js";

const commitCount = (gitDir: string, cwd: string): number =>
  execFileSync("git", ["log", "--oneline"], {
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd },
    cwd,
    encoding: "utf-8",
  }).trim().split("\n").filter(Boolean).length;

describe("shadowGitDir", () => {
  it("is deterministic for the same cwd", () => {
    expect(shadowGitDir("/tmp/project")).toBe(shadowGitDir("/tmp/project"));
  });

  it("differs for different cwds", () => {
    expect(shadowGitDir("/tmp/project-a")).not.toBe(shadowGitDir("/tmp/project-b"));
  });

  it("encodes the absolute path hash in the directory name", () => {
    const cwd = "/tmp/railgun-test-determinism";
    const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
    expect(shadowGitDir(cwd)).toBe(join(getHomeDir(), "checkpoints", hash));
  });
});

describe("snapshot and rollback", () => {
  let cwd: string;
  let gitDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "railgun-checkpoint-test-"));
    // Keep gitDir inside cwd so a single rm(cwd) cleans up both.
    gitDir = join(cwd, ".git-shadow");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("creates a shadow repo and commits on first snapshot", async () => {
    await writeFile(join(cwd, "hello.txt"), "original");
    snapshot(gitDir, cwd);
    expect(existsSync(gitDir)).toBe(true);
    expect(commitCount(gitDir, cwd)).toBe(1);
    const log = execFileSync("git", ["log", "--oneline"], {
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd },
      cwd,
      encoding: "utf-8",
    });
    expect(log).toContain("checkpoint");
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd },
      cwd,
      encoding: "utf-8",
    });
    expect(author.trim()).toBe("Railgun Checkpoint <railgun@localhost>");
  });

  it("second snapshot when no changes still returns (--allow-empty)", async () => {
    await writeFile(join(cwd, "file.txt"), "data");
    snapshot(gitDir, cwd);
    // No changes — second call should not throw
    expect(() => snapshot(gitDir, cwd)).not.toThrow();
  });

  it("rollback restores a file to its pre-snapshot content", async () => {
    await writeFile(join(cwd, "target.txt"), "original content");
    snapshot(gitDir, cwd);
    await writeFile(join(cwd, "target.txt"), "mutated content");
    rollback(gitDir, cwd);
    const result = await readFile(join(cwd, "target.txt"), "utf-8");
    expect(result).toBe("original content");
  });

  it("rollback restores a deleted file", async () => {
    const filePath = join(cwd, "deleteme.txt");
    await writeFile(filePath, "I exist");
    snapshot(gitDir, cwd);
    await unlink(filePath);
    expect(existsSync(filePath)).toBe(false);
    rollback(gitDir, cwd);
    expect(existsSync(filePath)).toBe(true);
    expect(await readFile(filePath, "utf-8")).toBe("I exist");
  });

  it("rollback with no shadow repo throws", () => {
    const nonexistentGitDir = join(tmpdir(), `railgun-no-exist-${Date.now()}`);
    expect(() => rollback(nonexistentGitDir, cwd)).toThrow();
  });

  it("rollback with existing but empty/uninitialised gitDir throws", async () => {
    const emptyGitDir = await mkdtemp(join(tmpdir(), "railgun-empty-git-"));
    try {
      expect(() => rollback(emptyGitDir, cwd)).toThrow("No checkpoint repo");
    } finally {
      await rm(emptyGitDir, { recursive: true, force: true });
    }
  });
});

describe("createCheckpointGuard", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "railgun-guard-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(shadowGitDir(cwd), { recursive: true, force: true });
  });

  it("beforeMutation snapshots once then is a no-op within the same turn", async () => {
    await writeFile(join(cwd, "a.txt"), "data");
    const guard = createCheckpointGuard(cwd);

    expect(guard.snapshotted).toBe(false);
    guard.beforeMutation();
    expect(guard.snapshotted).toBe(true);
    guard.beforeMutation(); // second call is a no-op
    expect(guard.snapshotted).toBe(true);

    // Only one commit should exist
    expect(commitCount(shadowGitDir(cwd), cwd)).toBe(1);
  });

  it("resetTurn re-arms the guard so the next beforeMutation takes a second snapshot", async () => {
    await writeFile(join(cwd, "b.txt"), "first");
    const guard = createCheckpointGuard(cwd);

    guard.beforeMutation();
    expect(guard.snapshotted).toBe(true);

    guard.resetTurn();
    expect(guard.snapshotted).toBe(false);

    await writeFile(join(cwd, "b.txt"), "second");
    guard.beforeMutation();
    expect(guard.snapshotted).toBe(true);

    // Two commits should exist
    expect(commitCount(shadowGitDir(cwd), cwd)).toBe(2);
  });
});
