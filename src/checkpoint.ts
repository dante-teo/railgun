import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { getHomeDir } from "./paths.js";

/** Deterministic dir per project cwd. */
export const shadowGitDir = (cwd: string): string => {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  return join(getHomeDir(), "checkpoints", hash);
};

/** Ensure the shadow repo exists. Idempotent. */
export const ensureShadowRepo = (gitDir: string): void => {
  if (existsSync(gitDir)) return;
  mkdirSync(gitDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { env: { ...process.env, GIT_DIR: gitDir } });
};

/** Snapshot all files in cwd into the shadow repo. Returns true if a new commit was created. */
export const snapshot = (gitDir: string, cwd: string): boolean => {
  ensureShadowRepo(gitDir);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd };
  execFileSync("git", ["add", "-A"], { cwd, env });
  try {
    execFileSync("git", ["commit", "-m", `checkpoint ${new Date().toISOString()}`, "--allow-empty"], { cwd, env });
    return true;
  } catch {
    return false; // nothing to commit (no changes since last snapshot)
  }
};

/** Restore working tree to the last snapshot (HEAD of the shadow repo). */
export const rollback = (gitDir: string, cwd: string): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd };
  execFileSync("git", ["checkout", "HEAD", "--", "."], { cwd, env });
};

/** Per-turn guard: snapshot once, skip subsequent calls in the same turn. */
export interface CheckpointGuard {
  /** Call before any file-mutating tool. Snapshots on first call per turn. */
  readonly beforeMutation: () => void;
  /** Call at the start of each new turn to re-arm the guard. */
  readonly resetTurn: () => void;
  /** Whether a snapshot was taken this turn. */
  readonly snapshotted: boolean;
}

export const createCheckpointGuard = (cwd: string): CheckpointGuard => {
  const gitDir = shadowGitDir(cwd);
  let _snapshotted = false;

  return {
    beforeMutation: () => {
      if (_snapshotted) return;
      snapshot(gitDir, cwd);
      _snapshotted = true;
    },
    resetTurn: () => { _snapshotted = false; },
    get snapshotted() { return _snapshotted; },
  };
};
