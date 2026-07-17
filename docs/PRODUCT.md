# Railgun product

Railgun is a desktop-only macOS coding-agent application. The supported user
surfaces are the app’s task, Scheduled, Settings, and knowledge interfaces.

The task history identifies live agent work without requiring the user to open
the task: the active task has a trailing spinner, and a just-completed task has
a green checkmark briefly before returning to its idle appearance.

Scheduled prompts are stored in the user’s existing `~/.railgun` data. They run
while the app is open; background execution is explicitly enabled from
**Settings → General** and includes both recurring prompts and midnight Dream
maintenance. Scheduled remains responsible for job definitions.

The bundled backend retains internal interactive, one-shot, RPC, ACP, and cron
modes for desktop startup, automation, diagnostics, and integration boundaries.
These modes are implementation surfaces, not separately distributed user
products or installation channels.

Install the direct signed app, which updates in-app. The legacy npm package and
terminal interfaces are retired; the bundled backend is an implementation
detail.
