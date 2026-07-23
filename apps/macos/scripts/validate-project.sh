#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../../.." && pwd)"
generate_project="$script_dir/generate-project.sh"
validate_app_icon="$script_dir/validate-app-icon-assets.sh"
validate_legal_notices="$script_dir/generate-legal-notices.mjs"
validate_node_runtime="$script_dir/validate-node-runtime.sh"
validate_backend="$script_dir/validate-backend.sh"

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
sparkle_framework="$derived_data/Build/Products/Debug/Railgun.app/Contents/Frameworks/Sparkle.framework"

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

validate_debug_launch_scheme() {
  local scheme_path="$1"
  shift

  if [[ ! -f "$scheme_path" ]]; then
    printf 'error: expected generated shared scheme at %s.\n' "$scheme_path" >&2
    exit 1
  fi

  if ! grep -Fq -- 'buildConfiguration = "Debug"' "$scheme_path"; then
    printf 'error: generated scheme does not use the Debug configuration: %s.\n' "$scheme_path" >&2
    exit 1
  fi

  for argument in "$@"; do
    if ! grep -Fq -- "$argument" "$scheme_path"; then
      printf 'error: generated scheme is missing launch argument %s: %s.\n' "$argument" "$scheme_path" >&2
      exit 1
    fi
  done
}

require_command xcodebuild
require_command node
require_command pnpm
"$validate_app_icon"
pnpm --dir "$repository_root/apps/desktop" run build:mock-backend
"$validate_node_runtime"
"$validate_backend"
RAILGUN_LEGAL_SKIP_INSTALLED_PACKAGES=1 node "$validate_legal_notices" --check
"$generate_project" "$first_output"
"$generate_project" "$second_output"

shared_schemes_directory="$project_file/xcshareddata/xcschemes"
validate_debug_launch_scheme \
  "$shared_schemes_directory/RailgunX Source Backend.xcscheme" \
  '--railgunx-backend-mode=source' \
  '--railgunx-source-root=$(SRCROOT)/scripts/.railgun-source-root'
validate_debug_launch_scheme \
  "$shared_schemes_directory/RailgunX Mock Backend.xcscheme" \
  '--railgunx-backend-mode=mock' \
  '--railgunx-mock-scenario=ready-idle' \
  '--railgunx-source-root=$(SRCROOT)/scripts/.railgun-source-root'

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

"$validate_app_icon" "$derived_data/Build/Products/Debug/Railgun.app"
"$validate_backend" --app-bundle "$derived_data/Build/Products/Debug/Railgun.app"

if [[ ! -d "$sparkle_framework" ]]; then
  printf 'error: Sparkle.framework was not embedded in the generated app bundle.\n' >&2
  exit 1
fi

build_scheme test
