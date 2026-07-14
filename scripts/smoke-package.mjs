import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  const diagnosticsWorker = resolve("dist/diagnostics/worker.js");
  await access(diagnosticsWorker);
  const { createInteractiveDiagnostics } = await import(pathToFileURL(resolve("dist/diagnostics/interactiveDiagnostics.js")).href);
  const diagnosticsLogDir = join(temporaryDirectory, "diagnostics");
  const diagnostics = createInteractiveDiagnostics({ logDir: diagnosticsLogDir, runId: "package-smoke" });
  diagnostics.observer.ready();
  diagnostics.observer.event({ event: "package_smoke", outcome: "success" });
  await diagnostics.close();
  const diagnosticRecords = (await readFile(join(diagnosticsLogDir, "interactive-latest.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  if (!diagnosticRecords.some(record => record.event === "package_smoke")) {
    throw new Error("Packaged diagnostics worker did not flush the smoke record");
  }
    const linkedExecutable = join(temporaryDirectory, "railgun");
    const isolatedHome = join(temporaryDirectory, "home");
    await mkdir(isolatedHome, { recursive: true });
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
