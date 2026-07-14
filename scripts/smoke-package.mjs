import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status ?? "signal"}): ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
};

const runPackageManager = (args) => {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args)
    : run(process.execPath, [npmExecPath, ...args]);
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), "railgun-package-smoke-"));

try {
  runPackageManager(["run", "build"]);

  const executable = resolve("dist/cli.js");
  const linkedExecutable = join(temporaryDirectory, "railgun");
  const isolatedHome = join(temporaryDirectory, "home");
  const invocation = process.platform === "win32"
    ? { command: process.execPath, args: [executable, "config"] }
    : await symlink(executable, linkedExecutable).then(() => ({
      command: linkedExecutable,
      args: ["config"],
    }));

  const output = run(invocation.command, invocation.args, {
    env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
  });
  const config = JSON.parse(output);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Packaged CLI config output must be a JSON object");
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
