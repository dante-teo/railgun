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
app_bundle="$derived_data_dir/Build/Products/Debug/Railgun.app"
app_executable="$app_bundle/Contents/MacOS/Railgun"
backend_mode='bundled'
mock_scenario='ready-idle'
source_root="$repo_root"

usage() {
  printf 'usage: %s [--backend-mode bundled|source|mock] [--mock-scenario SCENARIO] [--source-root DIRECTORY]\n' "${0##*/}" >&2
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-mode)
      [[ $# -ge 2 ]] || usage
      backend_mode="$2"
      shift 2
      ;;
    --mock-scenario)
      [[ $# -ge 2 ]] || usage
      mock_scenario="$2"
      shift 2
      ;;
    --source-root)
      [[ $# -ge 2 ]] || usage
      source_root="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

case "$backend_mode" in
  bundled|source|mock)
    ;;
  *)
    usage
    ;;
esac

require_command xcodebuild
"$project_root/scripts/generate-project.sh" "$project_dir"

xcodebuild build \
  -project "$project_dir/RailgunX.xcodeproj" \
  -scheme RailgunX \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$derived_data_dir"

if [[ ! -d "$app_bundle" || ! -x "$app_executable" ]]; then
  printf 'error: expected app bundle was not produced at %s.\n' "$app_bundle" >&2
  exit 1
fi

# Launch the bundle through LaunchServices so native About/Dock surfaces resolve
# the current AppIcon instead of treating the executable as a standalone process.
case "$backend_mode" in
  bundled)
    exec open -n -W "$app_bundle"
    ;;
  source)
    exec open -n -W "$app_bundle" --args \
      --railgunx-backend-mode=source \
      "--railgunx-source-root=$source_root"
    ;;
  mock)
    exec open -n -W "$app_bundle" --args \
      --railgunx-backend-mode=mock \
      "--railgunx-mock-scenario=$mock_scenario" \
      "--railgunx-source-root=$source_root"
    ;;
esac
