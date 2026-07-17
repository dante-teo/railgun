#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
catalog_directory="$project_root/Resources/Assets.xcassets/AppIcon.appiconset"
contents_file="$catalog_directory/Contents.json"

if [[ $# -gt 1 ]]; then
  printf 'usage: %s [PATH_TO_RAILGUNX_APP]\n' "${0##*/}" >&2
  exit 64
fi

if ! command -v sips >/dev/null 2>&1; then
  printf 'error: sips is required to validate native macOS icon representations.\n' >&2
  exit 127
fi

source_png="$project_root/Resources/RailgunIcon/RailgunIcon-1024.png"
source_dimensions="$(sips -g pixelWidth -g pixelHeight "$source_png")"
source_alpha="$(sips -g hasAlpha "$source_png")"
if [[ "$source_dimensions" != *"pixelWidth: 1024"* || "$source_dimensions" != *"pixelHeight: 1024"* || "$source_alpha" != *"hasAlpha: yes"* ]]; then
  printf 'error: canonical AppIcon source must be a 1024 × 1024 image with alpha.\n' >&2
  exit 1
fi

if [[ ! -s "$contents_file" ]]; then
  printf 'error: missing AppIcon Contents.json: %s\n' "$contents_file" >&2
  exit 1
fi

while IFS=' ' read -r size pixels scale_suffix; do
  filename="icon_${size}x${size}${scale_suffix}.png"
  image="$catalog_directory/$filename"
  if [[ ! -f "$image" ]]; then
    printf 'error: missing AppIcon representation: %s\n' "$image" >&2
    exit 1
  fi

  dimensions="$(sips -g pixelWidth -g pixelHeight "$image")"
  if [[ "$dimensions" != *"pixelWidth: $pixels"* || "$dimensions" != *"pixelHeight: $pixels"* ]]; then
    printf 'error: %s must be %s × %s pixels.\n' "$filename" "$pixels" "$pixels" >&2
    exit 1
  fi
done <<'REPRESENTATIONS'
16 16
16 32 @2x
32 32
32 64 @2x
128 128
128 256 @2x
256 256
256 512 @2x
512 512
512 1024 @2x
REPRESENTATIONS

if [[ $# -eq 1 ]]; then
  app_bundle="$1"
  info_plist="$app_bundle/Contents/Info.plist"
  resources_directory="$app_bundle/Contents/Resources"

  if [[ ! -f "$info_plist" ]]; then
    printf 'error: missing application Info.plist: %s\n' "$info_plist" >&2
    exit 1
  fi

  icon_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$info_plist" 2>/dev/null || true)"
  if [[ "$icon_name" != "AppIcon" ]]; then
    printf 'error: application CFBundleIconName must be AppIcon, found %q.\n' "$icon_name" >&2
    exit 1
  fi

  if [[ ! -f "$resources_directory/Assets.car" ]]; then
    printf 'error: compiled asset catalog is missing from %s.\n' "$app_bundle" >&2
    exit 1
  fi

  if [[ ! -f "$resources_directory/AppIcon.icns" ]]; then
    printf 'error: compiled AppIcon.icns is missing from %s.\n' "$app_bundle" >&2
    exit 1
  fi

  printf 'validated Dock, Finder, About, and notification icon wiring for %s\n' "$app_bundle"
else
  printf 'validated AppIcon catalog representations and source-independent dimensions\n'
fi
