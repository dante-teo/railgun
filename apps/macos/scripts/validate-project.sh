#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../../.." && pwd)"
generate_project="$script_dir/generate-project.sh"
validate_app_icon="$script_dir/validate-app-icon-assets.sh"
validate_backend="$script_dir/validate-backend.sh"
generate_appcast="$script_dir/generate-appcast.sh"
sign_nested_code="$script_dir/sign-nested-code.sh"

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
release_archive="$temporary_root/RailgunRelease.xcarchive"
release_artifact="$temporary_root/Railgun-0.0.0-darwin-arm64.zip"
release_appcast="$temporary_root/Railgun-appcast-arm64.xml"
sparkle_private_key_file="$temporary_root/sparkle-private-key.txt"
sparkle_public_key_file="$temporary_root/sparkle-public-key.txt"
lockfile="$script_dir/../Package.resolved"
project_file="$first_output/RailgunX.xcodeproj"
generated_lockfile="$first_output/RailgunX.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
sparkle_framework="$derived_data/Build/Products/Debug/Railgun.app/Contents/Frameworks/Sparkle.framework"
sparkle_private_key=""
sparkle_public_key=""

create_sparkle_test_keys() {
  local private_pem="$temporary_root/sparkle-private.pem"
  local public_der="$temporary_root/sparkle-public.der"
  local private_der="$temporary_root/sparkle-private.der"
  openssl genpkey -algorithm ED25519 -out "$private_pem"
  openssl pkey -in "$private_pem" -outform DER -out "$private_der"
  openssl pkey -in "$private_pem" -pubout -outform DER -out "$public_der"
  tail -c 32 "$private_der" | base64 > "$sparkle_private_key_file"
  tail -c 32 "$public_der" | base64 > "$sparkle_public_key_file"
  chmod 0600 "$sparkle_private_key_file"
  sparkle_private_key="$(<"$sparkle_private_key_file")"
  sparkle_public_key="$(<"$sparkle_public_key_file")"
  [[ -n "$sparkle_private_key" && -n "$sparkle_public_key" ]] || {
    printf 'error: failed to generate disposable Sparkle validation keys.\n' >&2
    exit 1
  }
}

build_scheme() {
  local action="$1"

  xcodebuild "$action" \
    -skipMacroValidation \
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

archive_release_configuration() {
  xcodebuild archive \
    -skipMacroValidation \
    -project "$project_file" \
    -scheme RailgunX \
    -configuration Release \
    -destination 'generic/platform=macOS' \
    -archivePath "$release_archive" \
    -derivedDataPath "$derived_data" \
    -clonedSourcePackagesDirPath "$source_packages" \
    -packageCachePath "$package_cache" \
    -onlyUsePackageVersionsFromResolvedFile \
    ARCHS=arm64 \
    ONLY_ACTIVE_ARCH=NO \
    CODE_SIGN_IDENTITY=- \
    DEVELOPMENT_TEAM= \
    RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY="$sparkle_public_key" \
    RAILGUNX_SPARKLE_FEED_ARCHITECTURE=arm64 \
    MARKETING_VERSION=0.0.0 \
    CURRENT_PROJECT_VERSION=1
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
require_command cargo
require_command openssl
[[ "$(uname -m)" == arm64 ]] || {
  printf 'error: Railgun native validation requires Apple silicon.\n' >&2
  exit 1
}
create_sparkle_test_keys
"$validate_app_icon"
"$validate_backend" --configuration Release
cargo xtask legal --check
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

[[ -f "$first_output/RailgunXRelease.entitlements" ]] || {
  printf 'error: generated release project is missing RailgunXRelease.entitlements.\n' >&2
  exit 1
}
/usr/bin/plutil -lint "$first_output/RailgunXRelease.entitlements"

build_scheme build

"$validate_app_icon" "$derived_data/Build/Products/Debug/Railgun.app"
"$validate_backend" --configuration Debug --app-bundle "$derived_data/Build/Products/Debug/Railgun.app"

if [[ ! -d "$sparkle_framework" ]]; then
  printf 'error: Sparkle.framework was not embedded in the generated app bundle.\n' >&2
  exit 1
fi

cargo build \
  --locked \
  --package railgun-mock-backend \
  --manifest-path "$repository_root/Cargo.toml"
build_scheme test

archive_release_configuration
release_app="$release_archive/Products/Applications/Railgun.app"
[[ -d "$release_app" ]] || {
  printf 'error: Release configuration did not produce an archived Railgun.app.\n' >&2
  exit 1
}
"$validate_app_icon" "$release_app"
"$validate_backend" --configuration Release --app-bundle "$release_app"
[[ -d "$release_app/Contents/Frameworks/Sparkle.framework" ]] || {
  printf 'error: Sparkle.framework was not embedded in the Release archive.\n' >&2
  exit 1
}

"$sign_nested_code" --app "$release_app" --identity -
codesign_details="$(/usr/bin/codesign -dvvv "$release_app" 2>&1)"
grep -q 'Runtime Version' <<< "$codesign_details"
/usr/bin/codesign --verify --strict --verbose=2 \
  "$release_app/Contents/Resources/backend/railgun-backend"

/usr/bin/ditto -c -k --keepParent "$release_app" "$release_artifact"
RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY="$sparkle_private_key" \
  "$generate_appcast" \
    --archive "$release_artifact" \
    --output "$release_appcast" \
    --download-url-prefix 'https://example.invalid/releases/' \
    --source-packages "$source_packages"
/usr/bin/xmllint --noout "$release_appcast"
grep -q 'sparkle:edSignature=' "$release_appcast"
grep -q "https://example.invalid/releases/$(basename "$release_artifact")" "$release_appcast"
printf 'validated ad-hoc signed Release archive and Sparkle appcast\n'
