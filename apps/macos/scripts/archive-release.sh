#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$project_root/../.." && pwd)"
generate_project="$script_dir/generate-project.sh"
sign_nested_code="$script_dir/sign-nested-code.sh"

usage() {
  printf 'usage: %s --architecture arm64|x86_64 --version VERSION --build NUMBER --identity IDENTITY --output DIRECTORY --source-packages-output DIRECTORY [--keychain PATH]\n' "${0##*/}" >&2
  exit 64
}

architecture=""
version=""
build_number=""
identity=""
output_directory=""
source_packages_output=""
keychain=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --architecture) architecture="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --build) build_number="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --output) output_directory="${2:-}"; shift 2 ;;
    --source-packages-output) source_packages_output="${2:-}"; shift 2 ;;
    --keychain) keychain="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$architecture" == arm64 || "$architecture" == x86_64 ]] || usage
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage
[[ "$build_number" =~ ^[0-9]+$ && -n "$identity" && -n "$output_directory" && -n "$source_packages_output" ]] || usage
: "${RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY:?set RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY to the Sparkle public key}"
: "${APPLE_ID:?set APPLE_ID for notarization}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?set APPLE_APP_SPECIFIC_PASSWORD for notarization}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID for notarization}"

for command in xcodebuild xcrun ditto; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'error: %s is required for a native release archive.\n' "$command" >&2
    exit 127
  }
done

mkdir -p "$output_directory"
mkdir -p "$source_packages_output"
work_directory="$(mktemp -d "${TMPDIR:-/tmp}/railgunx-release.XXXXXX")"
cleanup() { rm -rf "$work_directory"; }
trap cleanup EXIT

project_directory="$work_directory/project"
archive_path="$work_directory/RailgunX.xcarchive"
submission_zip="$work_directory/notarization-input.zip"
staged_app="$output_directory/RailgunX.app"
artifact_zip="$output_directory/RailgunX-${version}-darwin-${architecture}.zip"

"$generate_project" "$project_directory"

xcodebuild archive \
  -project "$project_directory/RailgunX.xcodeproj" \
  -scheme RailgunX \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$archive_path" \
  -derivedDataPath "$work_directory/DerivedData" \
  -clonedSourcePackagesDirPath "$work_directory/SourcePackages" \
  -packageCachePath "$work_directory/PackageCache" \
  -onlyUsePackageVersionsFromResolvedFile \
  ARCHS="$architecture" \
  ONLY_ACTIVE_ARCH=NO \
  CODE_SIGN_IDENTITY="$identity" \
  RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY="$RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY" \
  MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="$build_number"

app="$archive_path/Products/Applications/RailgunX.app"
[[ -d "$app" ]] || {
  printf 'error: archive did not produce RailgunX.app.\n' >&2
  exit 1
}

sign_args=(--app "$app" --identity "$identity")
[[ -z "$keychain" ]] || sign_args+=(--keychain "$keychain")
"$sign_nested_code" "${sign_args[@]}"

/usr/bin/ditto -c -k --keepParent "$app" "$submission_zip"
xcrun notarytool submit "$submission_zip" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"

/usr/bin/ditto "$app" "$staged_app"
/usr/bin/ditto -c -k --keepParent "$app" "$artifact_zip"
/usr/bin/ditto "$work_directory/SourcePackages" "$source_packages_output"
printf 'created signed and notarized artifacts:\n%s\n%s\n' "$staged_app" "$artifact_zip"
