#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
version_file="$project_root/.xcodegen-version"

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
