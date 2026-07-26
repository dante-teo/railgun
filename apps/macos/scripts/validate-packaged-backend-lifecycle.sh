#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s BACKEND\n' "${0##*/}" >&2
  exit 64
}

[[ $# -eq 1 && -x "$1" ]] || usage
backend="$1"
temporary_home="$(mktemp -d "${TMPDIR:-/tmp}/railgun-lifecycle.XXXXXX")"
cleanup() {
  [[ -z "${backend_pid:-}" ]] || kill -KILL "$backend_pid" 2>/dev/null || true
  rm -rf "$temporary_home"
}
trap cleanup EXIT

mkdir -p "$temporary_home/.railgun"
output="$temporary_home/stdout"
error="$temporary_home/stderr"
env -u DEVIN_TOKEN HOME="$temporary_home" RAILGUN_DESKTOP_RPC=1 "$backend" desktop >"$output" 2>"$error" &
backend_pid=$!
wait "$backend_pid" && status=0 || status=$?
backend_pid=''
[[ "$status" -ne 0 ]] || { printf 'error: unauthenticated desktop backend unexpectedly succeeded.\n' >&2; exit 1; }
grep -q '"type":"startup_status"' "$output"
grep -q '"status":"authentication_required"' "$output"
if grep -Eiq 'token|bearer|authorization' "$error"; then
  printf 'error: backend diagnostics exposed credential-shaped text.\n' >&2
  exit 1
fi
printf 'validated authentication-required startup and clean process exit\n'
