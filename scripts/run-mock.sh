#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"

cargo build --locked --package railgun-mock-backend --manifest-path "$repository_root/Cargo.toml"

exec "$script_dir/run.sh" \
  --backend-mode mock \
  --mock-scenario ready-idle \
  --source-root "$repository_root"
