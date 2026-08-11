#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s --candidate BUILD --previous BUILD --previous-tag TAG --current-tag TAG\n' "${0##*/}" >&2
  exit 64
}

candidate=''
previous=''
previous_tag=''
current_tag=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate) candidate="${2:-}"; shift 2 ;;
    --previous) previous="${2:-}"; shift 2 ;;
    --previous-tag) previous_tag="${2:-}"; shift 2 ;;
    --current-tag) current_tag="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$candidate" =~ ^[0-9]+$ && "$previous" =~ ^[0-9]+$ && -n "$previous_tag" && -n "$current_tag" ]] || usage

if [[ "$previous_tag" == "$current_tag" ]]; then
  if (( candidate < previous )); then
    printf 'error: release build %s cannot be lower than existing build %s for %s.\n' "$candidate" "$previous" "$current_tag" >&2
    exit 1
  fi
elif (( candidate <= previous )); then
  printf 'error: release build %s must exceed previous build %s from %s.\n' "$candidate" "$previous" "$previous_tag" >&2
  exit 1
fi

printf 'validated release build %s against %s (%s)\n' "$candidate" "$previous" "$previous_tag"
