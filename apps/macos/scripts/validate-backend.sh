#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage_backend="$script_dir/stage-backend.sh"
lifecycle_validation="$script_dir/validate-packaged-backend-lifecycle.mjs"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s [--architecture arm64|x86_64] [APP_BUNDLE | --app-bundle APP_BUNDLE]\n' "${0##*/}" >&2
  exit 64
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required to validate the native backend."
}

assert_macho_architecture() {
  local description="$1"
  local architecture="$2"
  case "$architecture" in
    arm64)
      [[ "$description" == *'Mach-O'* && "$description" == *'arm64'* && "$description" != *'x86_64'* ]] \
        || fail "expected an arm64 Mach-O binary, got: $description"
      ;;
    x86_64)
      [[ "$description" == *'Mach-O'* && "$description" == *'x86_64'* && "$description" != *'arm64'* ]] \
        || fail "expected an x86_64 Mach-O binary, got: $description"
      ;;
    *)
      fail "unsupported backend architecture: $architecture"
      ;;
  esac
}

app_bundle=''
validation_architecture=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-bundle)
      [[ $# -ge 2 && -z "$app_bundle" ]] || usage
      app_bundle="$2"
      shift 2
      ;;
    --architecture)
      [[ $# -ge 2 && -z "$validation_architecture" ]] || usage
      validation_architecture="$2"
      shift 2
      ;;
    -*)
      usage
      ;;
    *)
      [[ -z "$app_bundle" ]] || usage
      app_bundle="$1"
      shift
      ;;
  esac
done

[[ -x "$stage_backend" ]] || fail "backend staging script is missing or not executable."
[[ -f "$lifecycle_validation" ]] || fail "packaged backend lifecycle validation script is missing."
for command in file mktemp node pnpm rm uname; do
  require_command "$command"
done

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgun-backend-validation.XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

if [[ -z "$validation_architecture" ]]; then
  validation_architecture="$(uname -m)"
fi
[[ "$validation_architecture" == arm64 || "$validation_architecture" == x86_64 ]] \
  || fail "unsupported backend architecture: $validation_architecture"

assert_production_packages() {
  local railgun="$1"
  node - "$railgun" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const railgun = process.argv[2];
const forbidden = new Set([
  "tsx",
  "typescript",
  "typescript-language-server",
  "vitest",
  "@vitest/runner",
  "@vitest/expect",
  "@types/better-sqlite3",
]);
const names = [];

const visit = (directory) => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      visit(entryPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const packageJson = path.join(entryPath, "package.json");
    if (fs.existsSync(packageJson)) {
      const packageName = JSON.parse(fs.readFileSync(packageJson, "utf8")).name;
      if (typeof packageName === "string") names.push(packageName);
    }
    if (entry.name !== "node_modules") visit(path.join(entryPath, "node_modules"));
  }
};

visit(path.join(railgun, "node_modules"));
const developmentPackages = names.filter((name) => forbidden.has(name) || name.startsWith("@types/"));
if (developmentPackages.length > 0) {
  console.error(`development-only packages were deployed: ${developmentPackages.sort().join(", ")}`);
  process.exit(1);
}
NODE
}

validate_payload() {
  local backend="$1"
  local architecture="$2"
  local node_binary="$backend/node/bin/node"
  local railgun="$backend/railgun"
  local entrypoint="$railgun/dist/backend.js"
  local addon="$railgun/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  local darwin_arch="$architecture"
  [[ "$darwin_arch" == 'x86_64' ]] && darwin_arch='x64'
  local sqlite_vec_addon="$railgun/node_modules/sqlite-vec-darwin-$darwin_arch/vec0.dylib"
  local other_darwin_arch='arm64'
  [[ "$darwin_arch" == 'arm64' ]] && other_darwin_arch='x64'

  [[ -d "$backend" && -d "$railgun" ]] || fail "$architecture backend directory layout is incomplete."
  [[ -x "$node_binary" ]] || fail "$architecture bundled Node executable is missing."
  [[ -f "$entrypoint" ]] || fail "$architecture deployed backend entrypoint is missing."
  [[ -f "$addon" ]] || fail "$architecture rebuilt better_sqlite3.node is missing."
  [[ -f "$sqlite_vec_addon" ]] || fail "$architecture sqlite-vec native addon is missing."
  [[ ! -e "$railgun/node_modules/sqlite-vec-darwin-$other_darwin_arch" ]] \
    || fail "$architecture payload contains the mismatched $other_darwin_arch sqlite-vec addon."
  [[ -f "$railgun/package.json" && -d "$railgun/node_modules" ]] \
    || fail "$architecture deployed backend package layout is incomplete."

  assert_production_packages "$railgun"
  assert_macho_architecture "$(file -b "$node_binary")" "$architecture"
  assert_macho_architecture "$(file -b "$addon")" "$architecture"
  assert_macho_architecture "$(file -b "$sqlite_vec_addon")" "$architecture"

  "$node_binary" -e '
    const Database = require(process.argv[1]);
    const sqliteVec = require(process.argv[2]);
    const abi = process.versions.modules;
    if (!/^[0-9]+$/.test(abi)) throw new Error("staged Node did not report a Node ABI");
    const database = new Database(":memory:");
    sqliteVec.load(database);
    const result = database.prepare("select 1 as value, vec_version() as version").get();
    if (result.value !== 1 || typeof result.version !== "string") {
      throw new Error("SQLite native extension query returned an unexpected value");
    }
    database.close();
    process.stdout.write(`loaded better-sqlite3 with Node ABI ${abi}\n`);
  ' "$railgun/node_modules/better-sqlite3" "$railgun/node_modules/sqlite-vec"

  node "$lifecycle_validation" "$node_binary" "$entrypoint" "$architecture"
}

output="$temporary_root/$validation_architecture"
printf 'validating isolated backend staging for %s\n' "$validation_architecture"
"$stage_backend" --architecture "$validation_architecture" --output "$output"
validate_payload "$output/backend" "$validation_architecture"

if [[ -n "$app_bundle" ]]; then
  [[ -d "$app_bundle" ]] || fail "application bundle does not exist: $app_bundle"
  resources="$app_bundle/Contents/Resources"
  bundled_backend="$resources/backend"
  [[ -d "$bundled_backend" ]] || fail "application bundle is missing Contents/Resources/backend."

  bundled_node="$bundled_backend/node/bin/node"
  [[ -x "$bundled_node" ]] || fail "application bundle is missing its bundled Node executable."
  bundled_description="$(file -b "$bundled_node")"
  case "$bundled_description" in
    *'arm64'*) bundled_architecture='arm64' ;;
    *'x86_64'*) bundled_architecture='x86_64' ;;
    *) fail "application bundle Node executable is not a supported Mach-O architecture." ;;
  esac
  validate_payload "$bundled_backend" "$bundled_architecture"
  printf 'validated bundled backend in %s\n' "$app_bundle"
fi
