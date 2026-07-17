#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generate_project="$script_dir/generate-project.sh"
validate_app_icon="$script_dir/validate-app-icon-assets.sh"
validate_legal_notices="$script_dir/generate-legal-notices.mjs"

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
source_packages="$temporary_root/SourcePackages"
package_cache="$temporary_root/PackageCache"
lockfile="$script_dir/../Package.resolved"
project_file="$first_output/RailgunX.xcodeproj"
generated_lockfile="$first_output/RailgunX.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
sparkle_framework="$derived_data/Build/Products/Debug/RailgunX.app/Contents/Frameworks/Sparkle.framework"

build_scheme() {
  local action="$1"

  xcodebuild "$action" \
    -project "$project_file" \
    -scheme RailgunX \
    -configuration Debug \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived_data" \
    -clonedSourcePackagesDirPath "$source_packages" \
    -packageCachePath "$package_cache" \
    -onlyUsePackageVersionsFromResolvedFile \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=
}

require_command xcodebuild
require_command node
"$validate_app_icon"
node "$validate_legal_notices" --check
"$generate_project" "$first_output"
"$generate_project" "$second_output"

if ! diff -ru "$first_output" "$second_output"; then
  printf 'error: XcodeGen produced different project files in two fresh runs.\n' >&2
  exit 1
fi

xcodebuild -resolvePackageDependencies \
  -project "$project_file" \
  -scheme RailgunX \
  -clonedSourcePackagesDirPath "$source_packages" \
  -packageCachePath "$package_cache" \
  -disablePackageRepositoryCache \
  -onlyUsePackageVersionsFromResolvedFile

if ! diff -u "$lockfile" "$generated_lockfile"; then
  printf 'error: package resolution changed the generated lockfile. Run %s to intentionally refresh it.\n' \
    "$script_dir/resolve-packages.sh" >&2
  exit 1
fi

build_scheme build

"$validate_app_icon" "$derived_data/Build/Products/Debug/RailgunX.app"

if [[ ! -d "$sparkle_framework" ]]; then
  printf 'error: Sparkle.framework was not embedded in the generated app bundle.\n' >&2
  exit 1
fi

build_scheme test
