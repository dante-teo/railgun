import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { getGitStatus, formatCwd } from "./statusLine.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "railgun-statusline-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── getGitStatus ─────────────────────────────────────────────────────────

describe("getGitStatus", () => {
  it("returns branch and clean status for a fresh repo with one commit", () => {
    execFileSync("git", ["init", "--initial-branch=test-main"], { cwd: tempDir });
    execFileSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"], { cwd: tempDir });

    return getGitStatus(tempDir).then(status => {
      expect(status.branch).toBe("test-main");
      expect(status.dirty).toBe(false);
    });
  });

  it("returns dirty true after an uncommitted edit", async () => {
    execFileSync("git", ["init", "--initial-branch=test-main"], { cwd: tempDir });
    execFileSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "dirty.txt"), "uncommitted");

    const status = await getGitStatus(tempDir);
    expect(status.branch).toBe("test-main");
    expect(status.dirty).toBe(true);
  });

  it("returns branch null for a non-git directory", async () => {
    const status = await getGitStatus(tempDir);
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(false);
  });
});

// ── formatCwd ────────────────────────────────────────────────────────────

describe("formatCwd", () => {
  it("replaces homedir prefix with ~", () => {
    const home = homedir();
    expect(formatCwd(join(home, "Projects", "railgun"))).toBe("~/Projects/railgun");
  });

  it("returns non-home paths unchanged", () => {
    // Use a path that cannot be under homedir
    const fakePath = "/var/lib/some/other/path";
    if (!fakePath.startsWith(homedir())) {
      expect(formatCwd(fakePath)).toBe(fakePath);
    }
  });

  it("does not shorten paths that share a prefix but are not subdirectories", () => {
    const home = homedir();
    // e.g. /home/user → /home/user2 should NOT become ~/2
    expect(formatCwd(home + "2")).toBe(home + "2");
    expect(formatCwd(home + "2/project")).toBe(home + "2/project");
  });

  it("returns ~ for the home directory itself", () => {
    expect(formatCwd(homedir())).toBe("~");
  });
});
