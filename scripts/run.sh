#!/usr/bin/env bash

set -euo pipefail

require_command() {
  if ! command -v "$1" >/dev/null; then
    printf 'error: %s is required to run RailgunX.\n' "$1" >&2
    exit 127
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="$repo_root/apps/macos"
build_root="${RAILGUNX_BUILD_ROOT:-${TMPDIR:-/tmp}/railgunx}"
project_dir="$build_root/project"
derived_data_dir="$build_root/DerivedData"
app_executable="$derived_data_dir/Build/Products/Debug/RailgunX.app/Contents/MacOS/RailgunX"

require_command xcodegen
require_command xcodebuild
mkdir -p "$project_dir"

xcodegen generate \
  --spec "$project_root/project.yml" \
  --project-root "$project_root" \
  --project "$project_dir"

xcodebuild build \
  -project "$project_dir/RailgunX.xcodeproj" \
  -scheme RailgunX \
  -destination 'platform=macOS' \
  -derivedDataPath "$derived_data_dir"

if [[ ! -x "$app_executable" ]]; then
  printf 'error: expected app executable was not produced at %s.\n' "$app_executable" >&2
  exit 1
fi

exec "$app_executable"
