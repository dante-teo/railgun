# Railgun product

Railgun is a native, Apple-silicon macOS coding-agent application. The
supported user surfaces are the app’s task, Scheduled, Settings, and knowledge
interfaces. The former Electron application has been retired; it is not a
supported installation, development, or release surface.

The task history identifies live agent work without requiring the user to open
the task: the active task has a trailing spinner, and a just-completed task has
a green checkmark briefly before returning to its idle appearance.

The Task destination starts as an unsaved new task rather than a selection
placeholder, and Railgun does not save it until the user sends a message.
Assistant responses render as selectable Markdown while they stream, after
completion, and when restored from history; incomplete Markdown does not fall
back to a raw plain-text presentation. User prompts remain literal selectable
text. Code is syntax highlighted, wide tables scroll horizontally, and
available table actions support copying or saving their Markdown.
Settings → General lets users choose a default model for new tasks without
changing the active task's model, and configure an optional Advisor by selecting
its model and enabling it. Advisor notes appear in Activity and open on click
for reading and text selection. The model list is cached while Railgun is
connected, so choosing a model immediately acknowledges the choice while the
backend confirms it. **Refresh Models** is available in General when the user
wants to discover provider changes. If that refresh no longer offers the
current model, Railgun does not silently change the task; it keeps the picker
usable so the user can select a replacement.

Archiving a task immediately moves it out of the active list. If the backend
rejects the archive, Railgun restores the task in place, including its active
selection and visible transcript.

Scheduled prompts are stored in the user’s existing `~/.railgun` data. Railgun
starts a private scheduler after the desktop backend is ready and stops it when
the app closes, so recurring prompts run while the app is open. Railgun does
not install a login item, launchd agent, or other background service. Scheduled
remains responsible for job definitions. Its toolbar also provides New Task so
users can return to normal task work without first selecting a sidebar task.

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
