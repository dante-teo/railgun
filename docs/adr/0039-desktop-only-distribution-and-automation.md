# 0039. Desktop-only distribution and background automation

Date: 2026-07-16

## Status

Accepted. Supersedes ADR 0031 and ADR 0036 where they describe a public CLI,
npm distribution, Linux/systemd support, or Homebrew as the only desktop
channel.

## Decision

Railgun is a macOS desktop product. The root workspace is a private bundled
backend; its JSONL protocol is internal to Electron main and the bundled child
process. No global binary, npm publication, terminal UI, ACP server, or public
RPC surface is supported.

The Scheduled page owns persistent job definitions. Settings → General owns the
background-automation opt-in. On explicit opt-in it installs only
`sh.railgun.cron` and `sh.railgun.dream` in the current user's launchd domain.
They run the signed app's embedded Electron runtime with the bundled backend,
never a repository, global Node, pnpm, or `railgun` executable.

Direct and Homebrew artifacts are separate immutable update channels. Direct
builds can use the in-app updater; Homebrew builds disable it so Homebrew is the
sole update owner. Direct GitHub assets retain their `darwin-<arch>` target in
the file name for the GitHub-backed Electron update service.

## Consequences

Existing `~/.railgun` data is retained with no migration. Enabling automation
replaces only the two historical Railgun launchd labels. Background jobs never
start browser OAuth and exit normally without credentials.
