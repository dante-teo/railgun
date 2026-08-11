# Operational diagnostics

Railgun injects a concise runtime block into every general agent session. It
identifies the active surface (`desktop` or `cron`), process and version facts,
`~/.railgun`, and the fixed configuration,
state, extension, skill, cron, report, and log paths. Rebuilt model runtimes
retain the same surface.

## `railgun_inspect`

The default read-only `railgun_inspect` tool supports five bounded areas:

- `sessions`: the stored non-archived session summaries.
- `memories`: up to 20 saved memories.
- `cron`: the current cron job definitions and their recorded run state.
- `paths`: a fixed configured-state summary for state, cron, and skills paths.
- `config`: whether the state database and cron definition files exist.

The tool derives every path internally; callers cannot supply arbitrary paths.
Its serialized output is capped at 200,000 characters. It intentionally does
not return configuration contents, credentials, MCP environment values, logs,
or cron reports. Use the app's Settings controls for ordinary configuration
changes and inspect the relevant bounded area instead of assuming runtime
state.

## Configuration activation

Raw configuration edits must preserve unknown keys and existing MCP entries, avoid
displaying secret values, and produce valid JSON. Configuration and injected
instruction state are captured at backend startup. Restart the backend before
claiming a change is active. Diagnose configuration, MCP, extension, cron, and
desktop failures from inspected state and logs rather than assumptions.

Skills are the exception to the startup-capture rule: Railgun discovers
`~/.railgun/skills` afresh for every desktop or scheduled agent run, and the
Settings list performs its own discovery. A valid filesystem edit therefore
becomes available on the next run without restarting the backend.

## Background scheduler LaunchAgent

General Settings manages the per-user LaunchAgent at
`~/Library/LaunchAgents/sh.railgun.cron.plist`. Production source and packaged backend launches can
manage it; mock and unconfigured Electron launches report Background Scheduling as unavailable. An
installed plist is a private regular file with mode `0600`, runs the configured backend in
`scheduler` mode, and writes standard output and error to `~/.railgun/logs/scheduler.log`.

Settings reports Not installed, Running, Stopped, Repair needed, or Unavailable. Executable path,
hash, app version, working directory, permissions, malformed plist data, or the retired
`sh.railgun.dream.plist` can make an installation require repair. A packaged application may
best-effort repair an existing stale installation after an update, but it never installs one for a
user who previously uninstalled it.

Install and Repair unload current and legacy labels before replacing the plist, then use
`launchctl bootstrap` and `kickstart`. Uninstall does not delete either plist until `launchctl print`
confirms that both labels are absent; an already-unloaded result is safe, while an unverifiable or
still-loaded label leaves the plist files in place and surfaces an error. Use the Settings action
first. Inspect the plist metadata and `scheduler.log` only when status remains stopped or repair
fails, and never copy credentials or unrestricted configuration into a diagnostic report.

## Skill discovery and repair

Discovery accepts root-level Markdown files and nested directories containing
`SKILL.md`, normalizes CRLF input, and does not follow symlinks. Files with
invalid frontmatter, names, descriptions, or oversized bodies are skipped;
parse and read failures produce a backend warning. Duplicate effective names
are resolved by deterministic relative-path order; the first valid file wins
and later files are skipped with their paths in diagnostics.

If the skills root itself is a symlink, not a directory, or cannot be read,
ordinary desktop and scheduled prompts continue with no advertised skills.
This is deliberate because skills are optional prompting input. An explicit
`/skill:<name>` invocation instead reports that the requested skill could not
be loaded, and Settings exposes the discovery failure with Retry. Repair the
filesystem condition directly; malformed files are intentionally not rewritten
or deleted by discovery.

Managed Settings writes reject symlinked roots and targets, write
`<name>/SKILL.md` atomically with private permissions, and never recursively
delete a skill directory. If deletion leaves sibling assets behind, remove or
repair those assets manually only after confirming they are no longer needed.

## Devin authentication recovery

The file-backed Devin credential is stored at `~/.railgun/devin-token`.
`DEVIN_TOKEN`, when present in the environment that launches Railgun, takes
precedence and is never changed by the app. The standalone backend `login` and
`logout` modes manage the file-backed credential. If neither credential is
usable, the packaged backend reports `authentication_required` and the desktop
startup fails. Run the backend login flow before relaunching Railgun; the
current Electron renderer does not expose credential-management controls.

Model discovery uses the provider library's compatible default client identity,
while Devin login and chat requests identify as Devin Local. Keep those paths
separate: using the Local identity for discovery can return an empty model
catalog and prevent backend startup, while omitting it from chat requests can
reject Local-only models.

After a successful browser helper operation, relaunching Railgun establishes a
fresh RPC backend generation. A launch or initialization failure terminates the
desktop application with a backend-failure diagnostic instead of presenting a
task shell backed by a dead process. Never include the contents of
`~/.railgun/devin-token` or `DEVIN_TOKEN` in diagnostic output.

The renderer-facing configuration RPC is a security boundary: `config_get` and
`config_update` never return the stored `mcpServers` object. MCP commands expose
only the dedicated projection, where environment variable names may be shown
but values are never returned. MCP changes must use those commands so an
unrelated configuration update cannot echo persisted credentials onto RPC
stdout.
