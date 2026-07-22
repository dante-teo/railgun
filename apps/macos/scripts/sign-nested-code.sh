#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
node_entitlements="$project_root/NodeRuntime.entitlements"
app_entitlements="$project_root/RailgunXRelease.entitlements"

usage() {
  printf 'usage: %s --app PATH --identity IDENTITY [--keychain PATH]\n' "${0##*/}" >&2
  exit 64
}

app=""
identity=""
keychain=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --keychain) keychain="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -d "$app" && -n "$identity" ]] || usage
[[ -f "$node_entitlements" && -f "$app_entitlements" ]] || {
  printf 'error: required signing entitlements are missing.\n' >&2
  exit 1
}

sign_arguments=(--force --sign "$identity" --options runtime --timestamp)
if [[ -n "$keychain" ]]; then
  sign_arguments+=(--keychain "$keychain")
fi

sign_file() {
  local path="$1"
  if [[ "$path" == */Contents/Resources/backend/node/bin/node ]]; then
    /usr/bin/codesign "${sign_arguments[@]}" --entitlements "$node_entitlements" "$path"
  else
    /usr/bin/codesign "${sign_arguments[@]}" "$path"
  fi
}

main_executable="$app/Contents/MacOS/RailgunX"
[[ -f "$main_executable" ]] || {
  printf 'error: expected RailgunX executable at %s.\n' "$main_executable" >&2
  exit 1
}

# Sign leaf Mach-O code before its enclosing framework, helper, or bundle. The
# Node runtime and native addons live in Resources, outside Xcode's normal
# framework embedding rules, so they are deliberately included here.
while IFS= read -r -d '' candidate; do
  [[ "$candidate" == "$main_executable" ]] && continue
  if /usr/bin/file -b "$candidate" | grep -q 'Mach-O'; then
    sign_file "$candidate"
  fi
done < <(/usr/bin/find "$app/Contents" -type f -print0)

# Re-sign nested code containers after their contents. -depth guarantees that
# an inner helper is complete before its enclosing framework is sealed.
while IFS= read -r -d '' container; do
  /usr/bin/codesign "${sign_arguments[@]}" "$container"
done < <(/usr/bin/find "$app/Contents" -depth -type d \( \
  -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.appex' -o -name '*.bundle' \
\) -print0)

/usr/bin/codesign "${sign_arguments[@]}" --entitlements "$app_entitlements" "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
printf 'signed nested RailgunX code in %s\n' "$app"
