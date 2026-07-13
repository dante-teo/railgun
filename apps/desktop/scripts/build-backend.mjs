import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const backendRoot = resolve(desktopRoot, "backend");
const deployedRailgun = resolve(backendRoot, "railgun");

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

rmSync(backendRoot, { recursive: true, force: true });
run("pnpm", ["run", "build"], repositoryRoot);
run(
  "pnpm",
  ["--filter", "@dantea/railgun", "deploy", "--prod", deployedRailgun],
  repositoryRoot,
);
run("pnpm", ["exec", "vite", "build", "--config", "vite.mock.config.ts"], desktopRoot);
