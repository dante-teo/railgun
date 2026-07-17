#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
source_png="$project_root/Resources/RailgunIcon/RailgunIcon-1024.png"
output_directory="$project_root/Resources/Assets.xcassets/AppIcon.appiconset"

if [[ ! -f "$source_png" ]]; then
  printf 'error: missing canonical icon export: %s\n' "$source_png" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  printf 'error: sips is required to generate native macOS icon representations.\n' >&2
  exit 127
fi

source_dimensions="$(sips -g pixelWidth -g pixelHeight "$source_png")"
if [[ "$source_dimensions" != *"pixelWidth: 1024"* || "$source_dimensions" != *"pixelHeight: 1024"* ]]; then
  printf 'error: canonical icon export must be 1024 × 1024 pixels.\n' >&2
  exit 1
fi

source_alpha="$(sips -g hasAlpha "$source_png")"
if [[ "$source_alpha" != *"hasAlpha: yes"* ]]; then
  printf 'error: canonical AppIcon source must preserve transparent outside corners.\n' >&2
  exit 1
fi

mkdir -p "$output_directory"

while IFS=' ' read -r size pixels scale_suffix; do
  filename="icon_${size}x${size}${scale_suffix}.png"
  sips -z "$pixels" "$pixels" -s format png "$source_png" --out "$output_directory/$filename" >/dev/null
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

printf 'generated macOS AppIcon representations in %s\n' "$output_directory"
