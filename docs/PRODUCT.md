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
text. Each assistant row offers **Copy response** for the complete stored
Markdown source and **Select response** for one native selectable surface
spanning all Markdown blocks. Code is syntax highlighted, wide tables scroll
horizontally, and available table actions support copying or saving their
Markdown.
Settings → General lets users choose a default model for new tasks without
changing the active task's model, and configure an optional Advisor by selecting
its model and enabling it. Advisor notes appear in Activity and open on click
for reading and text selection. The model list is cached while Railgun is
connected, so choosing a model immediately acknowledges the choice while the
backend confirms it. **Refresh Models** is available in General when the user
wants to discover provider changes. If that refresh no longer offers the
current model, Railgun does not silently change the task; it keeps the picker
usable so the user can select a replacement.

**Settings → General → Devin** owns the file-backed authentication lifecycle.
When that credential is missing or rejected, Railgun opens Devin in the
default browser and reconnects after the browser-backed helper completes. The
same page provides **Log in**, **Log out**, and **Log in again**. An explicitly
configured `DEVIN_TOKEN` takes precedence over the file credential and remains
managed by the launch environment. If authentication finishes but the backend
cannot reconnect, Railgun presents **Backend Unavailable** and **Retry** rather
than keeping an unusable task shell visible.

Archiving a task immediately moves it out of the active list. If the backend
rejects the archive, Railgun restores the task in place, including its active
selection and visible transcript.

Scheduled prompts are stored in the user’s existing `~/.railgun` data. Railgun
offers **Settings → General → Background Scheduling** to install, repair, or
uninstall a per-user launchd agent. The agent runs the bundled backend directly;
it remains active after the app quits and never launches the Railgun GUI.
Installing or uninstalling the agent does not create or delete scheduled prompt
definitions. An already-installed stale or legacy agent is repaired when the
app migrates it or when the user chooses Repair in Settings.
Scheduled remains responsible for user job definitions, which can be edited
without the agent but run only while the background scheduler is installed.
Its toolbar also provides New Task so users can return to normal task work
without first selecting a sidebar task.

**Settings → Personalization** owns the one global custom instruction and agent
memory management. The custom-instruction editor has no file picker because
Railgun exposes only `~/.railgun/SOUL.md`; drafts are retained while moving
within Settings. On first read after upgrading, non-empty legacy
`~/.railgun.md` content is copied into an empty `SOUL.md` and the legacy file
is retained. Memory CRUD and search live in a native management sheet rather
than the main settings page. That sheet also exposes a manual Dream action
after at least five memories are available.

**Settings → Skills** manages valid reusable instructions discovered under
`~/.railgun/skills`. Users can search the list, inspect a rendered Markdown
preview, create or edit a skill, choose whether the model may invoke it, and
delete it after confirmation. Managed skills use
`~/.railgun/skills/<name>/SKILL.md`; editing never renames a skill, and deletion
does not recursively remove sibling assets. Malformed external files remain on
disk for manual repair.

For each new agent run, Railgun exposes only model-visible skill names and
descriptions, loading instruction bodies on demand. The model-facing
`skill_view` path enforces that visibility even when the model guesses a hidden
name or frontmatter alias. Users alone can bypass model visibility and invoke a
valid manual-only skill directly with `/skill:<name> [arguments]`. An unknown
skill stops at the prompt boundary with a safe error rather than starting a
task with unresolved instructions. Discovery is best-effort for ordinary and
scheduled prompts so a broken or unreadable optional skills directory cannot
make core prompting unavailable; explicit skill invocations still fail with a
targeted discovery error.

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
modes. The launchd agent owns the long-running scheduler mode. Nightly Dream
maintenance is a protected hidden midnight cron job within that scheduler, not
a second launch agent; it never appears in the user’s Scheduled list and does
not run nightly when background scheduling is uninstalled. Manual Dream remains
available from Personalization. These modes are implementation surfaces, not
separately distributed user products or installation channels.

Install the direct signed app, which updates in-app. There is no separate package or
terminal interface; the bundled backend is an implementation detail.
