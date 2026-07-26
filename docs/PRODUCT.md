# Railgun product

Railgun is a native, Apple-silicon macOS coding-agent application. The
supported user surfaces are the app’s task, Scheduled, Settings, and knowledge
interfaces. The former Electron application has been retired; it is not a
supported installation, development, or release surface.

The task history identifies live agent work without requiring the user to open
the task: the active task has a trailing spinner, and a just-completed task has
a green checkmark briefly before returning to its idle appearance.

Scheduled prompts are stored in the user’s existing `~/.railgun` data. Railgun
starts a private scheduler after the desktop backend is ready and stops it when
the app closes, so recurring prompts run while the app is open. Railgun does
not install a login item, launchd agent, or other background service. Scheduled
remains responsible for job definitions.

**Settings → Personalization** owns the one global custom instruction and agent
memory management. The custom-instruction editor has no file picker because
Railgun exposes only the one instruction stored under `~/.railgun`; drafts are
retained while moving within Settings. Memory CRUD and search live in a native
management sheet rather than the main settings page. That sheet also exposes a
manual Dream action after at least five memories are available.

Every attempted scheduled run also arrives in Task as a separate resumable
session. Delivery never changes the active task or sends a macOS notification.
New deliveries remain unread until opened and use the scheduled prompt as
their title. While the desktop app is open, it observes a monotonic delivery
cursor and refreshes the Task and Scheduled lists within five seconds of a new
delivery. A delivery retains the original prompt and available agent
transcript; incomplete, failed, and empty-result attempts also retain an
assistant message that explains the outcome. Users can inspect or continue
these tasks just like other tasks. When active task navigation reaches its
bounded capacity through recurring deliveries, the oldest scheduled deliveries
move to Archive rather than being deleted.

The bundled backend retains private desktop, scheduler, Dream, login, and logout
modes for native-app startup. The desktop app owns the scheduler mode while it
is running; these modes are implementation surfaces, not separately distributed
user products or installation channels.

Install the direct signed app, which updates in-app. There is no separate package or
terminal interface; the bundled backend is an implementation detail.
