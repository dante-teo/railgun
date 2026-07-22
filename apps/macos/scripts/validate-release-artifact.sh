#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validate_backend="$script_dir/validate-backend.sh"
validate_icon="$script_dir/validate-app-icon-assets.sh"

usage() {
  printf 'usage: %s --app PATH --archive ZIP --architecture arm64|x86_64 --appcast XML\n' "${0##*/}" >&2
  exit 64
}

app=""
archive=""
architecture=""
appcast=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --archive) archive="${2:-}"; shift 2 ;;
    --architecture) architecture="${2:-}"; shift 2 ;;
    --appcast) appcast="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -d "$app" && -f "$archive" && -f "$appcast" ]] || usage
[[ "$architecture" == arm64 || "$architecture" == x86_64 ]] || usage

info_plist="$app/Contents/Info.plist"
[[ -f "$info_plist" ]] || { printf 'error: app bundle is missing Info.plist.\n' >&2; exit 1; }
bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")"
feed_url="$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$info_plist")"
public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$info_plist")"
[[ "$bundle_identifier" == io.anvia.railgun ]] || { printf 'error: unexpected bundle identifier %s.\n' "$bundle_identifier" >&2; exit 1; }
[[ "$feed_url" == "https://github.com/dante-teo/railgun/releases/latest/download/RailgunX-appcast-${architecture}.xml" ]] || {
  printf 'error: architecture-specific HTTPS Sparkle feed is missing.\n' >&2
  exit 1
}
[[ -n "$public_key" && "$public_key" != *'$('* ]] || { printf 'error: Sparkle public EdDSA key was not injected.\n' >&2; exit 1; }

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
/usr/bin/codesign -dvvv "$app" 2>&1 | grep -q 'Runtime Version'
/usr/bin/codesign -d --entitlements :- "$app/Contents/Resources/backend/node/bin/node" 2>/dev/null | grep -q 'com.apple.security.cs.allow-jit'
spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"
"$validate_backend" --app-bundle "$app"
"$validate_icon" "$app"
[[ -d "$app/Contents/Frameworks/Sparkle.framework" ]] || { printf 'error: Sparkle.framework is missing.\n' >&2; exit 1; }

grep -q 'sparkle:edSignature=' "$appcast"
grep -q 'sparkle:signature=' "$appcast"
grep -q "RailgunX-appcast-${architecture}" "$appcast" || true
grep -q "$(basename "$archive")" "$appcast"

unpacked="$(mktemp -d "${TMPDIR:-/tmp}/railgunx-archive-validation.XXXXXX")"
cleanup() { rm -rf "$unpacked"; }
trap cleanup EXIT
/usr/bin/ditto -x -k "$archive" "$unpacked"
[[ -d "$unpacked/RailgunX.app" ]] || { printf 'error: archive does not contain RailgunX.app.\n' >&2; exit 1; }
printf 'validated signed RailgunX %s release artifact and Sparkle updater feed\n' "$architecture"
