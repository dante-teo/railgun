#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validate_app="$script_dir/validate-packaged-app.sh"

usage() {
  printf 'usage: %s --app PATH --archive ZIP --dmg DMG --metadata YAML --architecture arm64 --appcast XML --version VERSION --build BUILD\n' "${0##*/}" >&2
  exit 64
}

app=''
archive=''
dmg=''
metadata=''
architecture=''
appcast=''
version=''
build=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --archive) archive="${2:-}"; shift 2 ;;
    --dmg) dmg="${2:-}"; shift 2 ;;
    --metadata) metadata="${2:-}"; shift 2 ;;
    --architecture) architecture="${2:-}"; shift 2 ;;
    --appcast) appcast="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --build) build="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -d "$app" && -f "$archive" && -f "$dmg" && -f "$metadata" && -f "$appcast" && -n "$version" && -n "$build" ]] || usage
[[ "$architecture" == arm64 ]] || usage
[[ "$build" =~ ^[0-9]+$ ]] || usage
: "${RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY:?set the Sparkle private key only in CI secrets}"
: "${RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY:?set the Sparkle public key only in CI secrets}"
sign_update="$(command -v sign_update || true)"
[[ -x "$sign_update" ]] || {
  printf 'error: the pinned Sparkle sign_update tool is required.\n' >&2
  exit 1
}

validate_signed_app() {
  "$validate_app" \
    --app "$1" \
    --architecture "$architecture" \
    --version "$version" \
    --build "$build" \
    --sparkle-public-key "$RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY" \
    --signed
}

validate_signed_app "$app"
/usr/bin/hdiutil verify "$dmg"

archive_name="$(basename "$archive")"
dmg_name="$(basename "$dmg")"
archive_enclosure="$(grep -F "$archive_name" "$appcast" | head -n 1)"
archive_signature="$(sed -nE 's/.*sparkle:edSignature="([^"]+)".*/\1/p' <<< "$archive_enclosure")"
[[ -n "$archive_signature" ]] || {
  printf 'error: Sparkle appcast archive signature is missing.\n' >&2
  exit 1
}
printf '%s' "$RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY" | "$sign_update" \
  --ed-key-file - --verify "$archive" "$archive_signature"
grep -Fq "<sparkle:version>$build</sparkle:version>" "$appcast"
grep -Fq "<sparkle:shortVersionString>$version</sparkle:shortVersionString>" "$appcast"
grep -Fq '<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>' "$appcast"
grep -Fq '<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>' "$appcast"

archive_sha512="$(/usr/bin/openssl dgst -sha512 -binary "$archive" | /usr/bin/openssl base64 -A)"
dmg_sha512="$(/usr/bin/openssl dgst -sha512 -binary "$dmg" | /usr/bin/openssl base64 -A)"
grep -Fq "version: $version" "$metadata"
grep -Fq "$archive_name" "$metadata"
grep -Fq "$dmg_name" "$metadata"
grep -Fq "sha512: $archive_sha512" "$metadata"
grep -Fq "sha512: $dmg_sha512" "$metadata"
[[ -s "${archive}.blockmap" && -s "${dmg}.blockmap" ]] || {
  printf 'error: Electron blockmaps are missing.\n' >&2
  exit 1
}

unpacked="$(mktemp -d "${TMPDIR:-/tmp}/railgun-electron-archive.XXXXXX")"
mounted="$(mktemp -d "${TMPDIR:-/tmp}/railgun-electron-dmg.XXXXXX")"
attached=0
cleanup() {
  if [[ "$attached" -eq 1 ]]; then
    /usr/bin/hdiutil detach "$mounted" -quiet || true
  fi
  rm -rf "$unpacked" "$mounted"
}
trap cleanup EXIT
/usr/bin/ditto -x -k "$archive" "$unpacked"
[[ -d "$unpacked/Railgun.app" ]] || {
  printf 'error: archive does not contain Railgun.app.\n' >&2
  exit 1
}
if /usr/bin/zipinfo -1 "$archive" | grep -Ev '^Railgun\.app(/|$)' | grep -q .; then
  printf 'error: ZIP contains entries outside Railgun.app.\n' >&2
  exit 1
fi
validate_signed_app "$unpacked/Railgun.app"

/usr/bin/hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mounted" -quiet
attached=1
[[ -d "$mounted/Railgun.app" && -L "$mounted/Applications" && "$(readlink "$mounted/Applications")" == /Applications ]] || {
  printf 'error: DMG must contain Railgun.app and the /Applications link.\n' >&2
  exit 1
}
while IFS= read -r entry; do
  case "$(basename "$entry")" in
    Railgun.app|Applications|.background|.background.tiff|.DS_Store|.VolumeIcon.icns) ;;
    *) printf 'error: unexpected DMG root entry: %s\n' "$entry" >&2; exit 1 ;;
  esac
done < <(find "$mounted" -mindepth 1 -maxdepth 1 -print)
validate_signed_app "$mounted/Railgun.app"

printf 'validated signed Electron Railgun %s release artifacts and update feeds\n' "$architecture"
