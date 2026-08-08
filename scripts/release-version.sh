#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_file="$repository_root/apps/macos/project.yml"
desktop_package_file="$repository_root/apps/desktop/package.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s <major|minor|patch|X.Y.Z[-PRERELEASE]> [--dry-run]\n' "${0##*/}" >&2
  exit 64
}

dry_run=0
specifier=''
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=1 ;;
    --) ;;
    *) [[ -z "$specifier" ]] || usage; specifier="$argument" ;;
  esac
done
[[ -n "$specifier" ]] || usage

worktree="$(git -C "$repository_root" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "release versioning must run from a Git checkout."
[[ "$worktree" == "$repository_root" ]] \
  || fail "release versioning must run from the repository root checkout."

macos_current="$(awk '/^[[:space:]]*MARKETING_VERSION:/ { print $2; exit }' "$project_file")"
[[ "$macos_current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$ ]] \
  || fail "missing or invalid MARKETING_VERSION in apps/macos/project.yml."
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
desktop_current="$(awk -F '"' '/^[[:space:]]*"version":[[:space:]]*/ { print $4; exit }' "$desktop_package_file")"
[[ "$desktop_current" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || fail "missing or invalid version in apps/desktop/package.json."
[[ "$macos_current" == "$desktop_current" ]] \
  || fail "app versions are not aligned: macOS is $macos_current, Electron is $desktop_current."

current="$macos_current"

case "$specifier" in
  major) version="$((major + 1)).0.0" ;;
  minor) version="$major.$((minor + 1)).0" ;;
  patch) version="$major.$minor.$((patch + 1))" ;;
  *)
    [[ "$specifier" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
      || fail "unsupported release version \"$specifier\"."
    version="$specifier"
    ;;
esac
[[ "$version" != "$current" ]] || fail "version is already $version."
tag="v$version"

candidate_project="$(mktemp "${TMPDIR:-/tmp}/railgun-release-version.XXXXXX")"
candidate_desktop_package="$(mktemp "${TMPDIR:-/tmp}/railgun-desktop-release-version.XXXXXX")"
cleanup() {
  rm -f "$candidate_project" "$candidate_desktop_package"
}
trap cleanup EXIT

RAILGUN_RELEASE_CURRENT_VERSION="$current" \
RAILGUN_RELEASE_NEXT_VERSION="$version" \
  perl -0pe \
    's/^([ \t]*MARKETING_VERSION:[ \t]*)\Q$ENV{RAILGUN_RELEASE_CURRENT_VERSION}\E([ \t]*)$/${1}$ENV{RAILGUN_RELEASE_NEXT_VERSION}${2}/m' \
    "$project_file" > "$candidate_project"
candidate_version="$(awk '/^[[:space:]]*MARKETING_VERSION:/ { print $2 }' "$candidate_project")"
[[ "$candidate_version" == "$version" ]] \
  || fail "could not safely update MARKETING_VERSION in apps/macos/project.yml."

RAILGUN_RELEASE_CURRENT_VERSION="$current" \
RAILGUN_RELEASE_NEXT_VERSION="$version" \
  perl -0pe \
    's/^(\s*"version"\s*:\s*")\Q$ENV{RAILGUN_RELEASE_CURRENT_VERSION}\E("\s*,?\s*)$/${1}$ENV{RAILGUN_RELEASE_NEXT_VERSION}${2}/m' \
    "$desktop_package_file" > "$candidate_desktop_package"
candidate_desktop_version="$(awk -F '"' '/^[[:space:]]*"version":[[:space:]]*/ { print $4; exit }' "$candidate_desktop_package")"
[[ "$candidate_desktop_version" == "$version" ]] \
  || fail "could not safely update version in apps/desktop/package.json."

if [[ "$dry_run" -eq 1 ]]; then
  printf 'Would update apps/macos/project.yml: %s -> %s\n' "$current" "$version"
  printf 'Would update apps/desktop/package.json: %s -> %s\n' "$current" "$version"
  printf 'Would create commit "%s" and tag %s.\n' "$version" "$tag"
  exit 0
fi

[[ -z "$(git -C "$repository_root" status --porcelain)" ]] \
  || fail "release versioning requires a clean working tree."
if git -C "$repository_root" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  fail "tag $tag already exists."
fi

cp "$candidate_project" "$project_file"
cp "$candidate_desktop_package" "$desktop_package_file"
git -C "$repository_root" add apps/macos/project.yml apps/desktop/package.json
git -C "$repository_root" commit -m "$version"
git -C "$repository_root" tag -a "$tag" -m "$tag"
printf 'Created release commit and tag %s. Push with: git push origin main --tags\n' "$tag"
