#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_manifest="$script_dir/../Runtime/node-runtime.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required to stage the Node runtime."
  fi
}

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

usage() {
  printf 'usage: %s --architecture arm64|x86_64 --output DIRECTORY [--skip-execution]\n' "${0##*/}" >&2
  exit 64
}

architecture=''
output=''
verify_execution=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --architecture)
      [[ $# -ge 2 ]] || usage
      architecture="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || usage
      output="$2"
      shift 2
      ;;
    --skip-execution)
      verify_execution=0
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$architecture" == 'arm64' || "$architecture" == 'x86_64' ]] || usage
[[ -n "$output" ]] || usage
[[ -f "$runtime_manifest" ]] || fail "Node runtime manifest is missing: $runtime_manifest"

for command in awk curl file mkdir mktemp mv node rm rmdir shasum tar; do
  require_command "$command"
done

manifest_values="$(node -e '
const fs = require("node:fs");
const [manifestPath, architecture] = process.argv.slice(1);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Invalid Node runtime manifest: ${error.message}`);
  process.exit(1);
}
const runtime = manifest?.architectures?.[architecture];
const isSHA256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const archiveArchitecture = architecture === "x86_64" ? "x64" : architecture;
const expectedArchive = `node-v${manifest?.version}-darwin-${archiveArchitecture}.tar.xz`;
if (manifest?.schemaVersion !== 1
  || typeof manifest.version !== "string"
  || !runtime
  || runtime.archive !== expectedArchive
  || ![runtime.archive, runtime.url, runtime.sha256, runtime.machoArchitecture, manifest?.license?.sha256].every(Boolean)
  || manifest.license?.path !== "LICENSE"
  || !runtime.url.startsWith("https://nodejs.org/")
  || !runtime.url.endsWith(`/${runtime.archive}`)
  || !isSHA256(runtime.sha256)
  || !isSHA256(manifest.license.sha256)) {
  console.error("Node runtime manifest is malformed.");
  process.exit(1);
}
process.stdout.write([manifest.version, runtime.archive, runtime.url, runtime.sha256, manifest.license.sha256, runtime.machoArchitecture].join("\t"));
' "$runtime_manifest" "$architecture")" || fail "Unable to read Node runtime manifest."
IFS=$'\t' read -r expected_version archive_name archive_url archive_sha256 license_sha256 macho_architecture <<< "$manifest_values"

case "$macho_architecture" in
  arm64|x86_64) ;;
  *) fail "Node runtime manifest declares an invalid Mach-O architecture." ;;
esac

if [[ -e "$output/node" || -L "$output/node" ]]; then
  fail "Refusing to overwrite existing runtime output: $output/node"
fi

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgun-node-runtime.XXXXXX")"
staging_root=''
cleanup() {
  rm -rf "$temporary_root"
  [[ -z "$staging_root" ]] || rm -rf "$staging_root"
}
trap cleanup EXIT

archive_path="$temporary_root/$archive_name"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --silent --show-error \
  --output "$archive_path" "$archive_url"

actual_archive_sha256="$(sha256 "$archive_path")"
[[ "$actual_archive_sha256" == "$archive_sha256" ]] || fail "Downloaded Node archive checksum did not match the runtime manifest."

archive_root="${archive_name%.tar.xz}"
if ! tar -tJf "$archive_path" | awk -v root="$archive_root" '
  $0 != root && $0 != root "/" && index($0, root "/") != 1 { invalid = 1 }
  $0 ~ /^\// || $0 ~ /(^|\/)\.\.?(\/|$)/ { invalid = 1 }
  END { exit invalid }
'; then
  fail "Node runtime archive has an unexpected or unsafe layout."
fi

extraction_root="$temporary_root/extracted"
mkdir "$extraction_root"
if ! tar -xJf "$archive_path" -C "$extraction_root"; then
  fail "Node runtime archive could not be extracted."
fi

runtime_directory="$extraction_root/$archive_root"
node_binary="$runtime_directory/bin/node"
license_file="$runtime_directory/LICENSE"
[[ -d "$runtime_directory" && -x "$node_binary" && -f "$license_file" ]] || fail "Node runtime archive is missing its expected executable or license."

actual_license_sha256="$(sha256 "$license_file")"
[[ "$actual_license_sha256" == "$license_sha256" ]] || fail "Node runtime license checksum did not match the runtime manifest."

if (( verify_execution )); then
  actual_version="$($node_binary --version)" || fail "Staged Node executable could not run."
  [[ "$actual_version" == "v$expected_version" ]] || fail "Staged Node version $actual_version did not match v$expected_version."
fi

binary_description="$(file -b "$node_binary")"
case "$macho_architecture" in
  arm64)
    [[ "$binary_description" == *'Mach-O'* && "$binary_description" == *'arm64'* && "$binary_description" != *'x86_64'* ]] || fail "Staged Node executable is not an arm64 Mach-O binary."
    ;;
  x86_64)
    [[ "$binary_description" == *'Mach-O'* && "$binary_description" == *'x86_64'* && "$binary_description" != *'arm64'* ]] || fail "Staged Node executable is not an x86_64 Mach-O binary."
    ;;
esac

mkdir -p "$output"
if [[ -e "$output/node" || -L "$output/node" ]]; then
  fail "Refusing to overwrite existing runtime output: $output/node"
fi
staging_root="$(mktemp -d "$output/.node-runtime-staging.XXXXXX")"
mv "$runtime_directory" "$staging_root/node"
mv "$staging_root/node" "$output/node"
rmdir "$staging_root"
staging_root=''
