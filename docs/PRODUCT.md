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

Every attempted scheduled run also arrives in Task as a separate resumable
session. A run that finishes while the app is closed is persisted and appears
in the Task sidebar when the app next opens. Delivery never changes the active
task or sends a macOS notification. New deliveries remain unread until opened,
use the scheduled prompt as their title, and present only the final agent result
before any later user follow-up.
Incomplete and failed attempts remain available with an inline status warning,
so a user can inspect or continue them just like other tasks. When active task navigation
reaches its bounded capacity through recurring deliveries, the oldest scheduled
deliveries move to Archive rather than being deleted.

The bundled backend retains internal interactive, one-shot, RPC, ACP, and cron
modes for desktop startup, automation, diagnostics, and integration boundaries.
These modes are implementation surfaces, not separately distributed user
products or installation channels.

Install the direct signed app, which updates in-app. The legacy npm package and
terminal interfaces are retired; the bundled backend is an implementation
detail.
