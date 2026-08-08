#!/usr/bin/env bash

set -euo pipefail

require_command() {
  if ! command -v "$1" >/dev/null; then
    printf 'error: %s is required to run Railgun.\n' "$1" >&2
    exit 127
  fi
}

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_root="$repository_root/apps/desktop"

require_command pnpm

if [[ ! -f "$desktop_root/package.json" ]]; then
  printf 'error: Electron app was not found at %s.\n' "$desktop_root" >&2
  exit 1
fi

cd "$desktop_root"
exec pnpm dev "$@"
