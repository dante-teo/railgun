#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$script_dir/.railgun-source-root" ]]; then
  repository_root="$(<"$script_dir/.railgun-source-root")"
else
  repository_root="$(cd "$script_dir/../../.." && pwd)"
fi
repository_root="$(cd "$repository_root" && pwd)"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s --architecture arm64 --configuration Debug|Release --output DIRECTORY\n' "${0##*/}" >&2
  exit 64
}

architecture=''
configuration=''
output=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --architecture) architecture="${2:-}"; shift 2 ;;
    --configuration) configuration="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$architecture" == arm64 ]] || fail "the packaged backend supports arm64 only."
[[ "$configuration" == Debug || "$configuration" == Release ]] || usage
[[ -n "$output" ]] || usage
[[ -f "$repository_root/Cargo.lock" ]] || fail "Cargo.lock is missing."
command -v cargo >/dev/null 2>&1 || fail "cargo is required to stage the backend."
command -v file >/dev/null 2>&1 || fail "file is required to stage the backend."

if [[ "$configuration" == Release ]]; then
  cargo build --locked --release --package railgun-backend --manifest-path "$repository_root/Cargo.toml"
  source_binary="$repository_root/target/release/railgun-backend"
else
  cargo build --locked --package railgun-backend --manifest-path "$repository_root/Cargo.toml"
  source_binary="$repository_root/target/debug/railgun-backend"
fi

[[ -x "$source_binary" ]] || fail "Cargo did not produce $source_binary."
description="$(file -b "$source_binary")"
[[ "$description" == *Mach-O* && "$description" == *arm64* && "$description" != *"universal binary"* ]] \
  || fail "expected an arm64-only Mach-O backend, got: $description"

mkdir -p "$output"
staging="$(mktemp -d "$output/.railgun-backend-staging.XXXXXX")"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT
cp "$source_binary" "$staging/railgun-backend"
chmod 0755 "$staging/railgun-backend"

backup=''
if [[ -e "$output/backend" ]]; then
  backup="$output/.railgun-backend-previous.$$"
  mv "$output/backend" "$backup"
fi
if ! mv "$staging" "$output/backend"; then
  [[ -z "$backup" || -e "$output/backend" ]] || mv "$backup" "$output/backend"
  fail "unable to publish the staged backend."
fi
[[ -z "$backup" ]] || rm -rf "$backup"
trap - EXIT
printf 'staged %s backend at %s/backend/railgun-backend\n' "$configuration" "$output"
