#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
generate_project="$script_dir/generate-project.sh"
lockfile="$project_root/Package.resolved"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'error: %s is required to resolve RailgunX packages.\n' "$1" >&2
    exit 127
  fi
}

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/railgunx-package-resolution.XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

project_directory="$temporary_root/project"
generated_lockfile="$project_directory/RailgunX.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"

require_command xcodebuild
RAILGUNX_SKIP_LOCKFILE_SEED=1 "$generate_project" "$project_directory"

xcodebuild -resolvePackageDependencies \
  -project "$project_directory/RailgunX.xcodeproj" \
  -scheme RailgunX \
  -clonedSourcePackagesDirPath "$temporary_root/SourcePackages" \
  -packageCachePath "$temporary_root/PackageCache" \
  -disablePackageRepositoryCache

if [[ ! -f "$generated_lockfile" ]]; then
  printf 'error: package resolution did not create %s.\n' "$generated_lockfile" >&2
  exit 1
fi

cp "$generated_lockfile" "$lockfile"
printf 'updated %s\n' "$lockfile"
