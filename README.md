# Railgun for macOS

Railgun is a signed macOS desktop app for working with an AI coding agent. The
Node backend is bundled inside the app and is not a supported command-line or
npm product.

## Install and update

Choose one installation channel:

- Direct: download the signed app from the Railgun GitHub Release. The app
  checks the direct-release update feed, downloads updates in the background,
  and offers to restart when one is ready.
- Homebrew: install with `brew install --cask railgun`. Homebrew owns updates;
  run `brew upgrade --cask railgun`. The app deliberately disables its updater
  in this channel.

Do not install one channel over the other. Remove the old app first if you are
switching channels.

## Scheduled work and maintenance

Use the **Scheduled** page to create, edit, or remove prompts. Scheduled data,
credentials, sessions, skills, memories, and logs remain in `~/.railgun`.

Use **Settings → General** to control background automation. It is opt-in and
installs two user launchd agents:

- `sh.railgun.cron` runs scheduled prompts while the app is closed.
- `sh.railgun.dream` runs nightly maintenance at local midnight.

Settings reports whether launchd is healthy. Use **Repair** after moving or
updating the app if it reports an old app location. Disabling automation stops
both services without removing your scheduled jobs or other Railgun data.
If credentials are unavailable, background services exit normally; sign in from
Settings and launchd will run them on their next start.

## Recovery

If the app asks you to sign in, sign in from Settings and then retry. Background
services never open browser authentication; they exit cleanly until credentials
are available. Scheduler logs are retained under `~/.railgun/cron/logs/`.

## Development and release

`pnpm dev` runs the desktop app from source. `pnpm dev:mock` uses the desktop
mock backend. The release version is defined only in
`apps/desktop/package.json`; releases use `vX.Y.Z` tags and build both
direct and Homebrew artifacts for arm64 and x64. Create the version commit and
tag with `pnpm release:version patch`; see
[release instructions](docs/RELEASING.md) for the artifact and signing checks.

Run the desktop checks with:

```sh
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
```
