import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { rebuild } from "@electron/rebuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const backendRoot = resolve(desktopRoot, "backend");
const deployedRailgun = resolve(backendRoot, "railgun");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;

const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
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

// Forge rebuilds the app's dependencies, but this extra resource has its own
// production deployment and must target the embedded Node runtime explicitly.
await rebuild({
  buildPath: deployedRailgun,
  electronVersion,
  arch: process.arch,
  onlyModules: ["better-sqlite3"],
  force: true,
});

const electronEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
delete electronEnvironment.NODE_OPTIONS;
const betterSqlite3Path = resolve(deployedRailgun, "node_modules/better-sqlite3");
run(
  electronExecutable,
  [
    "-e",
    `const Database = require(${JSON.stringify(betterSqlite3Path)});`
      + "const database = new Database(':memory:'); database.close();",
  ],
  repositoryRoot,
  electronEnvironment,
);
console.log(`Verified better-sqlite3 for Electron ${electronVersion} (${process.arch}).`);

run("pnpm", ["run", "build:mock-backend"], desktopRoot);
