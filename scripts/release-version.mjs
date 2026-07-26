#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectFile = resolve(repositoryRoot, "apps/macos/project.yml");
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const fail = (message) => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
};

const usage = () => {
  process.stderr.write(
    "usage: pnpm run release:version -- <major|minor|patch|X.Y.Z[-PRERELEASE]> [--dry-run]\n",
  );
  process.exit(64);
};

const runGit = (args, options = {}) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", ...options });

const parseVersion = (value) => {
  const match = versionPattern.exec(value);
  if (!match) fail(`invalid semantic version ${JSON.stringify(value)}.`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
};

const formatVersion = ({ major, minor, patch, prerelease }) =>
  `${major}.${minor}.${patch}${prerelease === undefined ? "" : `-${prerelease}`}`;

const nextVersion = (current, specifier) => {
  if (versionPattern.test(specifier)) return formatVersion(parseVersion(specifier));

  switch (specifier) {
    case "major":
      return formatVersion({ major: current.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatVersion({ major: current.major, minor: current.minor + 1, patch: 0 });
    case "patch":
      return formatVersion({ major: current.major, minor: current.minor, patch: current.patch + 1 });
    default:
      fail(`unsupported release version ${JSON.stringify(specifier)}.`);
  }
};

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const dryRun = arguments_.includes("--dry-run");
const specifiers = arguments_.filter((argument) => argument !== "--dry-run");
if (specifiers.length !== 1) usage();

let worktree;
try {
  worktree = runGit(["rev-parse", "--show-toplevel"]).trim();
} catch {
  fail("release versioning must run from a Git checkout.");
}
if (resolve(worktree) !== repositoryRoot) {
  fail("release versioning must run from the repository root checkout.");
}

const project = readFileSync(projectFile, "utf8");
const projectVersionMatch = /^\s*MARKETING_VERSION:\s*([^\s#]+)\s*$/m.exec(project);
if (!projectVersionMatch) fail(`missing MARKETING_VERSION in ${relative(repositoryRoot, projectFile)}.`);

const current = parseVersion(projectVersionMatch[1]);
const version = nextVersion(current, specifiers[0]);
if (version === projectVersionMatch[1]) fail(`version is already ${version}.`);

const tag = `v${version}`;
if (dryRun) {
  process.stdout.write(`Would update ${relative(repositoryRoot, projectFile)}: ${projectVersionMatch[1]} -> ${version}\n`);
  process.stdout.write(`Would create commit ${JSON.stringify(version)} and tag ${tag}.\n`);
  process.exit(0);
}

if (runGit(["status", "--porcelain"]).trim() !== "") {
  fail("release versioning requires a clean working tree.");
}

try {
  runGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" });
  fail(`tag ${tag} already exists.`);
} catch (error) {
  if (error.status !== 1) throw error;
}

writeFileSync(
  projectFile,
  project.replace(projectVersionMatch[0], projectVersionMatch[0].replace(projectVersionMatch[1], version)),
);

try {
  runGit(["add", "apps/macos/project.yml"]);
  runGit(["commit", "-m", version], { stdio: "inherit" });
  runGit(["tag", "-a", tag, "-m", tag]);
} catch (error) {
  fail(`could not create release commit and tag for ${version}: ${error.message}`);
}

process.stdout.write(`Created release commit and tag ${tag}. Push with: git push origin main --tags\n`);
