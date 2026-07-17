#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$script_dir/.railgun-source-root" ]]; then
  repository_root="$(<"$script_dir/.railgun-source-root")"
else
  repository_root="$(cd "$script_dir/../../.." && pwd)"
fi
stage_runtime="$script_dir/stage-node-runtime.sh"
node_gyp_script="$repository_root/node_modules/node-gyp/bin/node-gyp.js"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s --architecture arm64|x86_64 --output DIRECTORY\n' "${0##*/}" >&2
  exit 64
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required to stage the native backend."
}

assert_macho_architecture() {
  local description="$1"
  local architecture="$2"

  case "$architecture" in
    arm64)
      [[ "$description" == *'Mach-O'* && "$description" == *'arm64'* && "$description" != *'x86_64'* ]] \
        || fail "staged native addon is not an arm64 Mach-O binary."
      ;;
    x86_64)
      [[ "$description" == *'Mach-O'* && "$description" == *'x86_64'* && "$description" != *'arm64'* ]] \
        || fail "staged native addon is not an x86_64 Mach-O binary."
      ;;
  esac
}

architecture=''
output=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --architecture)
      [[ $# -ge 2 && -z "$architecture" ]] || usage
      architecture="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 && -z "$output" ]] || usage
      output="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$architecture" == 'arm64' || "$architecture" == 'x86_64' ]] || usage
[[ -n "$output" && "$output" != '/' && "$output" != '.' && "$output" != '..' ]] || usage
[[ -x "$stage_runtime" ]] || fail "Node runtime staging script is missing or not executable."
[[ -f "$repository_root/package.json" && -f "$repository_root/pnpm-lock.yaml" ]] \
  || fail "repository package inputs are missing."
[[ -f "$repository_root/tsconfig.build.json" ]] || fail "backend build configuration is missing."
[[ -f "$node_gyp_script" ]] || fail "direct node-gyp dependency is missing: $node_gyp_script"

for command in clang++ file make mkdir mktemp mv node pnpm python3 rm; do
  require_command "$command"
done

if [[ -e "$output" || -L "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || fail "backend output must be a real directory: $output"
else
  mkdir -p "$output"
fi

if [[ -e "$output/backend" || -L "$output/backend" ]]; then
  [[ -d "$output/backend" && ! -L "$output/backend" ]] \
    || fail "refusing to replace an unsafe backend output: $output/backend"
fi

temporary_root="$(mktemp -d "$output/.railgun-backend-staging.XXXXXX")"
staging_backend="$temporary_root/backend"
deployed_railgun="$staging_backend/railgun"
backup_backend=''
published=0

cleanup() {
  if [[ "$published" -eq 0 && -n "$backup_backend" && -e "$backup_backend" && ! -e "$output/backend" ]]; then
    mv "$backup_backend" "$output/backend" || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

mkdir "$staging_backend"

printf 'building the TypeScript backend\n'
pnpm --dir "$repository_root" run build

printf 'staging the pinned Node runtime (%s)\n' "$architecture"
"$stage_runtime" --architecture "$architecture" --output "$staging_backend"

staged_node="$staging_backend/node/bin/node"
staged_node_root="$staging_backend/node"
[[ -x "$staged_node" ]] || fail "staged Node executable is missing."

printf 'deploying the production backend dependency closure\n'
# Run pnpm with the staged runtime so optional native dependencies are
# selected for the requested artifact architecture, rather than the host
# architecture (which is arm64 when building x86_64 on Apple silicon).
pnpm_cli="$(command -v pnpm)"
PATH="$staged_node_root/bin:$PATH" \
  "$staged_node" "$pnpm_cli" --dir "$repository_root" \
  --filter @dantea/railgun deploy --prod "$deployed_railgun"

[[ -f "$deployed_railgun/dist/backend.js" ]] || fail "production backend deployment is missing dist/backend.js."
[[ -d "$deployed_railgun/node_modules" ]] || fail "production backend deployment is missing node_modules."
# pnpm's automatic peer installation can retain optional @types peers from the
# workspace importer even with --prod. They are not runtime dependencies and
# must not become part of the shipped production closure.
rm -rf "$deployed_railgun/node_modules/@types"

better_sqlite3="$deployed_railgun/node_modules/better-sqlite3"
addon="$better_sqlite3/build/Release/better_sqlite3.node"
[[ -d "$better_sqlite3" && -f "$better_sqlite3/binding.gyp" ]] \
  || fail "deployed better-sqlite3 source is missing."
[[ -f "$staged_node_root/include/node/node.h" ]] \
  || fail "staged Node headers are missing; refusing to download a different header set."

darwin_arch="$architecture"
[[ "$darwin_arch" == 'x86_64' ]] && darwin_arch='x64'
sqlite_vec_addon="$deployed_railgun/node_modules/sqlite-vec-darwin-$darwin_arch/vec0.dylib"
[[ -f "$sqlite_vec_addon" ]] \
  || fail "deployed sqlite-vec does not contain the $architecture native addon."
other_darwin_arch='arm64'
[[ "$darwin_arch" == 'arm64' ]] && other_darwin_arch='x64'
[[ ! -e "$deployed_railgun/node_modules/sqlite-vec-darwin-$other_darwin_arch" ]] \
  || fail "deployed sqlite-vec contains the mismatched $other_darwin_arch native addon."
assert_macho_architecture "$(file -b "$sqlite_vec_addon")" "$architecture"

# pnpm deploy may have run better-sqlite3's install hook and left a prebuild in
# place. Remove it before invoking node-gyp so the published addon is always
# compiled by the staged runtime against the staged runtime's headers.
rm -rf "$better_sqlite3/build"

node_arch="$architecture"
[[ "$node_arch" == 'x86_64' ]] && node_arch='x64'
printf 'rebuilding better-sqlite3 against Node ABI %s\n' "$($staged_node -p 'process.versions.modules')"
(
  cd "$better_sqlite3"
  npm_config_arch="$node_arch" \
  npm_config_build_from_source=true \
  npm_config_nodedir="$staged_node_root" \
    "$staged_node" "$node_gyp_script" rebuild --nodedir="$staged_node_root"
)

[[ -f "$addon" ]] || fail "node-gyp did not produce better_sqlite3.node."
assert_macho_architecture "$(file -b "$addon")" "$architecture"

"$staged_node" -e '
  const Database = require(process.argv[1]);
  const sqliteVec = require(process.argv[2]);
  const database = new Database(":memory:");
  sqliteVec.load(database);
  const result = database.prepare("select 1 as value, vec_version() as version").get();
  if (result.value !== 1 || typeof result.version !== "string") process.exit(1);
  database.close();
  process.stdout.write(`verified better-sqlite3 for Node ABI ${process.versions.modules}\n`);
' "$better_sqlite3" "$deployed_railgun/node_modules/sqlite-vec"

# Only the generated backend directory is replaced. Keep the previous
# directory available until the complete staged payload has passed validation,
# and restore it if the final move fails.
if [[ -e "$output/backend" ]]; then
  backup_backend="$output/.railgun-backend-previous.$$"
  [[ ! -e "$backup_backend" && ! -L "$backup_backend" ]] || fail "backend publish backup path already exists."
  mv "$output/backend" "$backup_backend"
fi
if ! mv "$staging_backend" "$output/backend"; then
  if [[ -n "$backup_backend" && -e "$backup_backend" && ! -e "$output/backend" ]]; then
    mv "$backup_backend" "$output/backend" || true
  fi
  fail "unable to publish the staged backend."
fi
published=1
if [[ -n "$backup_backend" ]]; then
  rm -rf "$backup_backend"
fi

printf 'staged backend at %s/backend\n' "$output"
