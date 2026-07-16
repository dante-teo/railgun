#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export RAILGUNX_BACKEND_MODE=mock
exec "$script_dir/run.sh"
