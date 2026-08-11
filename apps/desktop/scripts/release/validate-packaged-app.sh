#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validate_backend="$script_dir/validate-backend.sh"

usage() {
  printf 'usage: %s --app PATH --architecture arm64 --version VERSION [--build BUILD] [--sparkle-public-key KEY] [--signed]\n' "${0##*/}" >&2
  exit 64
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

app=''
architecture=''
version=''
build=''
sparkle_public_key=''
signed=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --architecture) architecture="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --build) build="${2:-}"; shift 2 ;;
    --sparkle-public-key) sparkle_public_key="${2:-}"; shift 2 ;;
    --signed) signed=1; shift ;;
    *) usage ;;
  esac
done

[[ -d "$app" && "$architecture" == arm64 && -n "$version" ]] || usage
info_plist="$app/Contents/Info.plist"
resources="$app/Contents/Resources"
backend="$resources/backend/railgun-backend"
executable="$app/Contents/MacOS/Railgun"

[[ -f "$info_plist" && -x "$executable" && -x "$backend" ]] || {
  printf 'error: packaged Railgun app is incomplete.\n' >&2
  exit 1
}

read_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$info_plist"; }
[[ "$(read_plist CFBundleIdentifier)" == io.anvia.railgun ]] || fail "unexpected bundle identifier."
[[ "$(read_plist CFBundleShortVersionString)" == "$version" ]] || fail "unexpected marketing version."
[[ "$(read_plist LSMinimumSystemVersion)" == 15.0 ]] || fail "unexpected minimum system version."
public_key="$(read_plist SUPublicEDKey)"
placeholder_prefix="\${"
[[ -n "$public_key" && "$public_key" != *"$placeholder_prefix"* ]] || fail "Sparkle public key was not injected."
if [[ -n "$sparkle_public_key" ]]; then
  [[ "$public_key" == "$sparkle_public_key" ]] || fail "Sparkle public key does not match the configured release key."
fi
if [[ -n "$build" ]]; then
  [[ "$(read_plist CFBundleVersion)" == "$build" ]] || fail "unexpected numeric build version."
fi

for binary in "$executable" "$backend"; do
  description="$(file -b "$binary")"
  [[ "$description" == *Mach-O* && "$description" == *arm64* && "$description" != *"universal binary"* ]] || {
    printf 'error: expected arm64-only Mach-O binary, got: %s\n' "$description" >&2
    exit 1
  }
done

[[ -s "$resources/legal/LegalNoticeManifest.json" ]] || fail "legal notice manifest is missing."
[[ -s "$resources/legal/ThirdPartyNotices.md" ]] || fail "third-party notices are missing."
[[ -s "$resources/LICENSE.electron.txt" ]] || fail "Electron license is missing."
[[ -s "$resources/LICENSES.chromium.html" ]] || fail "Chromium notices are missing."
[[ -s "$resources/app-update.yml" ]] || fail "Electron update configuration is missing."
grep -Fq 'provider: github' "$resources/app-update.yml" || fail "Electron updater provider is invalid."
grep -Fq 'owner: dante-teo' "$resources/app-update.yml" || fail "Electron updater owner is invalid."
grep -Fq 'repo: railgun' "$resources/app-update.yml" || fail "Electron updater repository is invalid."
[[ ! -d "$app/Contents/Frameworks/Sparkle.framework" ]] || fail "Sparkle must not be bundled at runtime."

while IFS= read -r -d '' candidate; do
  description="$(file -b "$candidate")"
  if [[ "$description" == *Mach-O* ]]; then
    [[ "$description" == *arm64* && "$description" != *x86_64* && "$description" != *"universal binary"* ]] || {
      printf 'error: expected arm64-only packaged Mach-O binary at %s, got: %s\n' "$candidate" "$description" >&2
      exit 1
    }
  fi
done < <(find "$app" -type f -perm -111 -print0)

"$validate_backend" --architecture "$architecture" --configuration Release --app-bundle "$app"

if [[ "$signed" -eq 1 ]]; then
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  /usr/bin/codesign --verify --strict --verbose=2 "$backend"
  codesign_details="$(/usr/bin/codesign -dvvv "$app" 2>&1)"
  grep -q 'Identifier=io.anvia.railgun' <<< "$codesign_details"
  grep -q 'Runtime Version' <<< "$codesign_details"
  backend_codesign_details="$(/usr/bin/codesign -dvvv "$backend" 2>&1)"
  grep -q 'Runtime Version' <<< "$backend_codesign_details"
  /usr/sbin/spctl --assess --type execute --verbose=2 "$app"
  /usr/bin/xcrun stapler validate "$app"
fi

printf 'validated packaged Electron Railgun %s application\n' "$architecture"
