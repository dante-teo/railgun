#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s --archive ZIP --output APPCAST_XML --download-url-prefix HTTPS_URL --source-packages DIRECTORY\n' "${0##*/}" >&2
  exit 64
}

archive=""
output=""
download_url_prefix=""
source_packages=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) archive="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --download-url-prefix) download_url_prefix="${2:-}"; shift 2 ;;
    --source-packages) source_packages="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$archive" && -n "$output" && -d "$source_packages" ]] || usage
[[ "$download_url_prefix" == https://* ]] || {
  printf 'error: Sparkle update archives must be served over HTTPS.\n' >&2
  exit 1
}
: "${RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY:?set the Sparkle private key only in CI secrets}"

generate_appcast="$(/usr/bin/find "$source_packages" -type f -name generate_appcast -perm -u+x -print -quit)"
[[ -n "$generate_appcast" ]] || {
  printf 'error: Sparkle generate_appcast was not found under %s.\n' "$source_packages" >&2
  exit 1
}

updates_directory="$(mktemp -d "${TMPDIR:-/tmp}/railgunx-appcast.XXXXXX")"
cleanup() { rm -rf "$updates_directory"; }
trap cleanup EXIT

/bin/cp "$archive" "$updates_directory/"
printf '%s' "$RAILGUNX_SPARKLE_PRIVATE_EDDSA_KEY" | "$generate_appcast" \
  --ed-key-file - \
  --download-url-prefix "$download_url_prefix" \
  "$updates_directory"

generated_appcast="$(/usr/bin/find "$updates_directory" -maxdepth 1 -type f -name '*.xml' -print -quit)"
[[ -n "$generated_appcast" ]] || {
  printf 'error: Sparkle did not generate an appcast XML file.\n' >&2
  exit 1
}
mkdir -p "$(dirname "$output")"
/bin/cp "$generated_appcast" "$output"
printf 'generated signed Sparkle appcast: %s\n' "$output"
