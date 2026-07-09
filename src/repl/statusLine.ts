import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";

export interface GitStatus {
  readonly branch: string | null;
  readonly dirty: boolean;
}

const execGit = (args: readonly string[], cwd: string): Promise<string | null> => {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile("git", [...args], { cwd }, (err, stdout) => {
    resolve(err ? null : stdout.trim());
  });
  return promise;
};

export const getGitStatus = async (cwd: string): Promise<GitStatus> => {
  const branch = await execGit(["branch", "--show-current"], cwd);
  if (branch === null) return { branch: null, dirty: false };
  const porcelain = await execGit(["status", "--porcelain"], cwd);
  return { branch: branch === "" ? "(detached)" : branch, dirty: (porcelain ?? "").length > 0 };
};

export const formatCwd = (cwd: string): string => {
  const home = homedir();
  return cwd === home ? "~"
    : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
};
