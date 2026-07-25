import Foundation
import SwiftUI

enum RailgunScheduledPresentation {
    static func lastRunText(for job: RailgunScheduledJob) -> String {
        guard let lastRun = job.lastRun else { return "Not yet run" }
        return lastRun.formatted(date: .abbreviated, time: .shortened)
    }

    static func statusText(for job: RailgunScheduledJob) -> String {
        switch job.lastStatus {
        case .completed: "Completed"
        case .incomplete: "Incomplete"
        case .failed: "Failed"
        case nil: "Not yet run"
        }
    }

    static var localTimeText: String {
        let zone = TimeZone.current.localizedName(for: .standard, locale: .current) ?? TimeZone.current.identifier
        return "Times shown in \(zone)"
    }

    static func promptLabel(for prompt: String) -> String {
        prompt.count > 160 ? String(prompt.prefix(157)) + "…" : prompt
    }
}

struct RailgunScheduledWorkspace: View {
    @Bindable var appStore: RailgunAppStore
    let coordinator: RailgunScheduledCoordinator
    @State private var editor: Editor?
    @State private var deletionTarget: RailgunScheduledJob?

    var body: some View {
        Group {
            if appStore.state.scheduled.isLoading && appStore.state.scheduled.jobs.isEmpty {
                ProgressView("Loading scheduled jobs…")
            } else if appStore.state.scheduled.jobs.isEmpty {
                ContentUnavailableView(
                    "No Scheduled Jobs",
                    systemImage: "clock",
                    description: Text("Create a schedule to run a prompt automatically.")
                )
            } else {
                List(appStore.state.scheduled.jobs) { job in
                    RailgunScheduledJobRow(
                        job: job,
                        isDisabled: appStore.state.scheduled.isMutating,
                        edit: { editor = .edit(job) },
                        delete: { deletionTarget = job }
                    )
                }
                .listStyle(.inset)
            }
        }
        .overlay(alignment: .top) {
            if let error = appStore.state.scheduled.error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(10)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding()
            }
        }
        .toolbar {
#if compiler(>=6.2)
                    if #available(macOS 26.0, *) {
                        ToolbarSpacer(.flexible, placement: .principal)
                    } else {
                        ToolbarItem(placement: .principal) {
                            Spacer()
                        }
                    }
#else
                    ToolbarItem(placement: .principal) {
                        Spacer()
                    }
#endif
            ToolbarItem(placement: .primaryAction) {
                Button("New Schedule", systemImage: "plus") {
                    editor = .new
                }
                .disabled(appStore.state.scheduled.isMutating)
            }
        }
        .sheet(item: $editor) { editor in
            RailgunScheduleEditor(
                editor: editor,
                isSubmitting: appStore.state.scheduled.isMutating,
                error: appStore.state.scheduled.error,
                submit: { prompt, schedule in
                    let succeeded: Bool
                    switch editor {
                    case .new:
                        succeeded = await coordinator.create(prompt: prompt, schedule: schedule)
                    case let .edit(job):
                        succeeded = await coordinator.update(job, prompt: prompt, schedule: schedule)
                    }
                    if succeeded { self.editor = nil }
                    return succeeded
                },
                cancel: { self.editor = nil }
            )
        }
        .confirmationDialog(
            "Delete Schedule",
            isPresented: Binding(get: { deletionTarget != nil }, set: { if !$0 { deletionTarget = nil } }),
            titleVisibility: .visible,
            presenting: deletionTarget
        ) { job in
            Button("Delete \(RailgunScheduledPresentation.promptLabel(for: job.prompt))", role: .destructive) {
                Task {
                    if await coordinator.remove(job) { deletionTarget = nil }
                }
            }
            .disabled(appStore.state.scheduled.isMutating)
        } message: { job in
            Text("Delete the schedule for “\(RailgunScheduledPresentation.promptLabel(for: job.prompt))”? This cannot be undone.")
        }
    }

    enum Editor: Identifiable {
        case new
        case edit(RailgunScheduledJob)

        var id: String {
            switch self {
            case .new: "new"
            case let .edit(job): job.id
            }
        }
    }
}

private struct RailgunScheduledJobRow: View {
    let job: RailgunScheduledJob
    let isDisabled: Bool
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(job.prompt)
                    .font(.headline)
                    .lineLimit(2)
                Text(job.schedule)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text("Last run: \(RailgunScheduledPresentation.lastRunText(for: job))")
                    Text(RailgunScheduledPresentation.statusText(for: job))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let error = job.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 12)
            Menu {
                Button("Edit", action: edit)
                Button("Delete", role: .destructive, action: delete)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .disabled(isDisabled)
        }
        .padding(.vertical, 5)
    }
}

private struct RailgunScheduleEditor: View {
    let editor: RailgunScheduledWorkspace.Editor
    let isSubmitting: Bool
    let error: String?
    let submit: (String, String) async -> Bool
    let cancel: () -> Void
    @State private var prompt: String
    @State private var schedule: String
    @State private var validationError: String?

    init(
        editor: RailgunScheduledWorkspace.Editor,
        isSubmitting: Bool,
        error: String?,
        submit: @escaping (String, String) async -> Bool,
        cancel: @escaping () -> Void
    ) {
        self.editor = editor
        self.isSubmitting = isSubmitting
        self.error = error
        self.submit = submit
        self.cancel = cancel
        switch editor {
        case .new:
            _prompt = State(initialValue: "")
            _schedule = State(initialValue: "")
        case let .edit(job):
            _prompt = State(initialValue: job.prompt)
            _schedule = State(initialValue: job.schedule)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(editorTitle).font(.headline)
            TextField("Prompt", text: $prompt, axis: .vertical)
                .lineLimit(3...8)
            TextField("Schedule (e.g. 0 9 * * 1-5)", text: $schedule)
                .font(.system(.body, design: .monospaced))
            Text("Five cron fields: minute hour day-of-month month day-of-week.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let message = validationError ?? error {
                Text(message).font(.callout).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).disabled(isSubmitting)
                Button(editorTitle, action: submitEditor)
                    .buttonStyle(.borderedProminent)
                    .disabled(isSubmitting)
            }
        }
        .padding(20)
        .frame(width: 480)
        .interactiveDismissDisabled(isSubmitting)
    }

    private var editorTitle: String {
        if case .new = editor { return "New Schedule" }
        return "Edit Schedule"
    }

    private func submitEditor() {
        let normalized = RailgunScheduledForm.normalized(prompt: prompt, schedule: schedule)
        guard let message = RailgunScheduledForm.validationMessage(prompt: normalized.prompt, schedule: normalized.schedule) else {
            prompt = normalized.prompt
            schedule = normalized.schedule
            validationError = nil
            Task { _ = await submit(normalized.prompt, normalized.schedule) }
            return
        }
        validationError = message
    }
}
