#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$project_root/../.." && pwd)"
version_file="$project_root/.xcodegen-version"
lockfile="$project_root/Package.resolved"

usage() {
  printf 'usage: %s OUTPUT_DIRECTORY\n' "${0##*/}" >&2
  exit 64
}

require_pinned_xcodegen() {
  local required_version actual_version

  if [[ ! -f "$version_file" ]]; then
    printf 'error: missing pinned XcodeGen version file: %s.\n' "$version_file" >&2
    exit 1
  fi

  required_version="$(<"$version_file")"
  if [[ ! "$required_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'error: invalid XcodeGen version %q in %s.\n' "$required_version" "$version_file" >&2
    exit 1
  fi

  if ! command -v xcodegen >/dev/null 2>&1; then
    printf 'error: XcodeGen %s is required but was not found. Install that version and ensure `xcodegen --version` reports it.\n' "$required_version" >&2
    exit 127
  fi

  actual_version="$(xcodegen --version 2>&1 | awk '/^[Vv]ersion:[[:space:]]*/ { print $2; exit }')"
  if [[ "$actual_version" != "$required_version" ]]; then
    printf 'error: XcodeGen %s is required; found %s. Install the pinned version, then rerun this script.\n' \
      "$required_version" "${actual_version:-an unrecognized version}" >&2
    exit 1
  fi
}

seed_package_lockfile() {
  local generated_lockfile

  if [[ "${RAILGUNX_SKIP_LOCKFILE_SEED:-0}" == "1" ]]; then
    return
  fi

  if [[ ! -f "$lockfile" ]]; then
    printf 'error: missing checked-in package lockfile: %s. Run %s to create it.\n' \
      "$lockfile" "$script_dir/resolve-packages.sh" >&2
    exit 1
  fi

  generated_lockfile="$output_directory/RailgunX.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
  mkdir -p "$(dirname "$generated_lockfile")"
  cp "$lockfile" "$generated_lockfile"
}

seed_backend_staging_inputs() {
  local scripts_directory="$output_directory/scripts"
  local runtime_directory="$output_directory/Runtime"

  mkdir -p "$scripts_directory" "$runtime_directory"
  cp "$project_root/scripts/stage-backend.sh" "$scripts_directory/stage-backend.sh"
  cp "$project_root/scripts/stage-node-runtime.sh" "$scripts_directory/stage-node-runtime.sh"
  cp "$project_root/Runtime/node-runtime.json" "$runtime_directory/node-runtime.json"
  printf '%s\n' "$repository_root" > "$scripts_directory/.railgun-source-root"
  chmod +x "$scripts_directory/stage-backend.sh" "$scripts_directory/stage-node-runtime.sh"
}

seed_info_plist() {
  local resources_directory="$output_directory/Resources"

  mkdir -p "$resources_directory"
  cp "$project_root/Resources/Info.plist" "$resources_directory/Info.plist"
}

seed_release_entitlements() {
  cp "$project_root/RailgunXRelease.entitlements" \
    "$output_directory/RailgunXRelease.entitlements"
}

if [[ $# -ne 1 ]]; then
  usage
fi

output_directory="$1"

require_pinned_xcodegen
mkdir -p "$output_directory"

xcodegen generate \
  --spec "$project_root/project.yml" \
  --project-root "$project_root" \
  --project "$output_directory"

seed_package_lockfile
seed_backend_staging_inputs
seed_info_plist
seed_release_entitlements
