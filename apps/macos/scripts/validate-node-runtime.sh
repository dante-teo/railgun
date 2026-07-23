#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage_runtime="$script_dir/stage-node-runtime.sh"
runtime_manifest="$script_dir/../Runtime/node-runtime.json"
bundled_node_license="$script_dir/../Resources/Legal/Sources/Node.js-LICENSE.txt"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required to validate the Node runtime."
}

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

for command in cmp file node shasum uname; do
  require_command "$command"
done
[[ -x "$stage_runtime" ]] || fail "Node runtime staging script is missing or not executable."
[[ -f "$bundled_node_license" ]] || fail "Bundled Node runtime license source is missing."

runtime_values="$(node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const architecture = "arm64";
const runtime = manifest?.architectures?.[architecture];
if (!runtime || !manifest.version || !manifest.license?.sha256) process.exit(1);
console.log([architecture, manifest.version, runtime.machoArchitecture, runtime.sha256, manifest.license.sha256].join("\t"));
' "$runtime_manifest")" || fail "Node runtime manifest is malformed."

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgun-node-runtime-validation.XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

host_architecture="$(uname -m)"
[[ "$host_architecture" == arm64 ]] \
  || fail "Node runtime validation requires an arm64 host, got: $host_architecture."

assert_runtime() {
  local architecture="$1"
  local expected_version="$2"
  local expected_macho_architecture="$3"
  local expected_archive_sha256="$4"
  local expected_license_sha256="$5"
  local runtime_directory="$temporary_root/$architecture/node"
  local binary="$runtime_directory/bin/node"
  local license="$runtime_directory/LICENSE"

  [[ "$expected_archive_sha256" =~ ^[a-f0-9]{64}$ ]] || fail "$architecture archive checksum is malformed."
  [[ "$expected_macho_architecture" == 'arm64' ]] || fail "$architecture Mach-O architecture is malformed."
  [[ -d "$runtime_directory" && -d "$runtime_directory/bin" && -d "$runtime_directory/lib" && -d "$runtime_directory/share" ]] || fail "$architecture runtime layout is incomplete."
  [[ -x "$binary" && -f "$license" ]] || fail "$architecture runtime is missing an executable Node binary or LICENSE."
  [[ "$(sha256 "$license")" == "$expected_license_sha256" ]] || fail "$architecture LICENSE checksum did not match the manifest."
  cmp -s "$license" "$bundled_node_license" || fail "$architecture LICENSE did not match the bundled legal notice source."
  [[ "$("$binary" --version)" == "v$expected_version" ]] || fail "$architecture Node version did not match the manifest."

  local binary_description
  binary_description="$(file -b "$binary")"
  [[ "$binary_description" == *'Mach-O'* && "$binary_description" == *"$expected_macho_architecture"* && "$binary_description" != *'universal binary'* ]] \
    || fail "$architecture Node binary was not arm64-only."
}

while IFS=$'\t' read -r architecture version macho_architecture archive_sha256 license_sha256; do
  "$stage_runtime" --architecture "$architecture" --output "$temporary_root/$architecture"
  assert_runtime "$architecture" "$version" "$macho_architecture" "$archive_sha256" "$license_sha256"
done <<< "$runtime_values"
