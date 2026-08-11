#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s --archive ZIP --output APPCAST_XML --download-url-prefix HTTPS_URL\n' "${0##*/}" >&2
  exit 64
}

archive=""
output=""
download_url_prefix=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) archive="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --download-url-prefix) download_url_prefix="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$archive" && -n "$output" ]] || usage
[[ "$download_url_prefix" == https://* ]] || {
  printf 'error: Sparkle update archives must be served over HTTPS.\n' >&2
  exit 1
}
: "${RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY:?set the Sparkle private key only in CI secrets}"
: "${RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY:?set the Sparkle public key only in CI secrets}"

generate_appcast="$(command -v generate_appcast || true)"
[[ -x "$generate_appcast" ]] || {
  printf 'error: the pinned Sparkle generate_appcast tool is required.\n' >&2
  exit 1
}

work_directory="$(mktemp -d "${TMPDIR:-/tmp}/railgun-appcast.XXXXXX")"
updates_directory="$work_directory/updates"
unpacked_directory="$work_directory/unpacked"
cleanup() { rm -rf "$work_directory"; }
trap cleanup EXIT

mkdir -p "$updates_directory" "$unpacked_directory"
/usr/bin/ditto -x -k "$archive" "$unpacked_directory"
info_plist="$unpacked_directory/Railgun.app/Contents/Info.plist"
[[ -f "$info_plist" ]] || {
  printf 'error: Sparkle archive must contain Railgun.app.\n' >&2
  exit 1
}
archive_public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$info_plist")"
[[ "$archive_public_key" == "$RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY" ]] || {
  printf 'error: Sparkle archive public key does not match the configured release key.\n' >&2
  exit 1
}

/bin/cp "$archive" "$updates_directory/"
# Sparkle leaves an archive unsigned when SUPublicEDKey does not correspond to
# the supplied private key. Requiring its signature completes the key-pair check.
printf '%s' "$RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY" | "$generate_appcast" \
  --ed-key-file - \
  --download-url-prefix "$download_url_prefix" \
  "$updates_directory"

generated_appcast="$(/usr/bin/find "$updates_directory" -maxdepth 1 -type f -name '*.xml' -print -quit)"
[[ -n "$generated_appcast" ]] || {
  printf 'error: Sparkle did not generate an appcast XML file.\n' >&2
  exit 1
}
grep -Fq 'sparkle:edSignature="' "$generated_appcast" || {
  printf 'error: Sparkle did not sign the archive; verify the configured EdDSA key pair.\n' >&2
  exit 1
}
mkdir -p "$(dirname "$output")"
/bin/cp "$generated_appcast" "$output"
printf 'generated signed Sparkle appcast: %s\n' "$output"
