#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage_backend="$script_dir/stage-backend.sh"
lifecycle="$script_dir/validate-packaged-backend-lifecycle.sh"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s [--architecture arm64] [--configuration Debug|Release] [--app-bundle APP]\n' "${0##*/}" >&2
  exit 64
}

architecture=''
configuration='Release'
app=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --architecture) architecture="${2:-}"; shift 2 ;;
    --configuration) configuration="${2:-}"; shift 2 ;;
    --app-bundle) app="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$architecture" ]] || architecture="$(uname -m)"
[[ "$architecture" == arm64 ]] || fail "native backend validation requires arm64."

assert_binary() {
  local binary="$1"
  [[ -x "$binary" ]] || fail "backend executable is missing: $binary"
  local description
  description="$(file -b "$binary")"
  [[ "$description" == *Mach-O* && "$description" == *arm64* && "$description" != *"universal binary"* ]] \
    || fail "expected an arm64-only Mach-O backend, got: $description"
  "$lifecycle" "$binary"
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgun-backend-validation.XXXXXX")"
cleanup() { rm -rf "$temporary_root"; }
trap cleanup EXIT
"$stage_backend" --architecture "$architecture" --configuration "$configuration" --output "$temporary_root"
assert_binary "$temporary_root/backend/railgun-backend"

if [[ -n "$app" ]]; then
  [[ -d "$app" ]] || fail "application bundle does not exist: $app"
  assert_binary "$app/Contents/Resources/backend/railgun-backend"
fi

printf 'validated locked %s Rust backend\n' "$configuration"
