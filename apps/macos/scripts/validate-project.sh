#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generate_project="$script_dir/generate-project.sh"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'error: %s is required to validate RailgunX.\n' "$1" >&2
    exit 127
  fi
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgunx-project-validation.XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

first_output="$temporary_root/first"
second_output="$temporary_root/second"
derived_data="$temporary_root/DerivedData"

require_command xcodebuild
"$generate_project" "$first_output"
"$generate_project" "$second_output"

if ! diff -ru "$first_output" "$second_output"; then
  printf 'error: XcodeGen produced different project files in two fresh runs.\n' >&2
  exit 1
fi

xcodebuild build \
  -project "$first_output/RailgunX.xcodeproj" \
  -scheme RailgunX \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=
