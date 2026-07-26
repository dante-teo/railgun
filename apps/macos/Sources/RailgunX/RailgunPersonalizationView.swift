import Observation
import RailgunUI
import SwiftUI

struct RailgunPersonalizationView: View {
    @Bindable private var store: RailgunPersonalizationStore
    @State private var isMemoryManagerPresented = false

    init(store: RailgunPersonalizationStore) {
        _store = Bindable(store)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: RailgunSpacing.layout.points) {
                instructionSection
                Divider()
                memoriesSection
            }
            .padding(RailgunSpacing.layout.points)
        }
        .navigationTitle("Personalization")
        .task {
            async let instructions: Void = store.loadCustomInstruction()
            async let memories: Void = store.loadMemories(query: "")
            _ = await (instructions, memories)
        }
        .sheet(isPresented: $isMemoryManagerPresented) {
            RailgunMemoryManagerView(store: store)
        }
    }

    private var instructionSection: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
            VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
                Text("Custom Instructions")
                    .font(RailgunFont.interface(.title2, weight: .semibold))
                Text("Tell Railgun how you want it to work. These instructions are stored in ~/.railgun.")
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)
            }

            if store.isLoadingInstructions && store.instructionFile == nil {
                ProgressView("Loading custom instructions…")
                    .frame(maxWidth: .infinity, minHeight: 220)
            } else if let error = store.instructionError, store.instructionFile == nil {
                unavailable("Custom instructions unavailable", message: error) {
                    Task { await store.loadCustomInstruction() }
                }
            } else if let file = store.instructionFile {
                VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
                    Label(file.label, systemImage: "text.document")
                        .font(RailgunFont.interface(.callout, weight: .medium))
                        .foregroundStyle(RailgunColorRole.secondaryText.color)

                    TextEditor(text: instructionDraft)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 260)
                        .padding(8)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityLabel("Custom instructions")

                    HStack {
                        Text(instructionIsDirty ? "Unsaved changes" : "Saved")
                            .font(RailgunFont.interface(.caption))
                            .foregroundStyle(RailgunColorRole.secondaryText.color)
                        Spacer()
                        Button("Revert") {
                            store.revertInstructionDraft()
                        }
                        .disabled(!instructionIsDirty || store.isSavingInstruction)
                        Button(store.isSavingInstruction ? "Saving…" : "Save") {
                            Task { _ = await store.saveInstruction() }
                        }
                        .disabled(!instructionIsDirty || store.isSavingInstruction)
                        .keyboardShortcut("s", modifiers: .command)
                    }

                    if let error = store.instructionError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(RailgunFont.interface(.caption))
                            .foregroundStyle(.red)
                    }
                }
            } else {
                ContentUnavailableView(
                    "No Custom Instructions",
                    systemImage: "text.document",
                    description: Text("The backend did not report any editable instruction files.")
                )
            }
        }
    }

    private var memoriesSection: some View {
        HStack(alignment: .center, spacing: RailgunSpacing.standard.points) {
            VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
                Text("Memories")
                    .font(RailgunFont.interface(.title2, weight: .semibold))
                Text(memorySummary)
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)
            }
            Spacer()
            Button("Manage Memories") {
                isMemoryManagerPresented = true
            }
        }
        .padding(RailgunSpacing.standard.points)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var memorySummary: String {
        if store.isLoadingMemories { return "Loading memories…" }
        let count = store.memoryCount
        return "\(count) \(count == 1 ? "memory" : "memories") available to Railgun."
    }

    private var instructionIsDirty: Bool {
        store.isInstructionDirty
    }

    private var instructionDraft: Binding<String> {
        Binding(
            get: { store.instructionDraft },
            set: { store.updateInstructionDraft($0) }
        )
    }

    @ViewBuilder
    private func unavailable(_ title: String, message: String, retry: @escaping () -> Void) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry", action: retry)
        }
    }
}

private struct RailgunMemoryManagerView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable private var store: RailgunPersonalizationStore
    @State private var query = ""
    @State private var editor: MemoryEditor?
    @State private var deletionTarget: RailgunAgentMemory?

    init(store: RailgunPersonalizationStore) {
        _store = Bindable(store)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: RailgunSpacing.standard.points) {
                HStack {
                    TextField("Filter memories", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { refresh() }
                    Button("Search", action: refresh)
                        .disabled(store.isLoadingMemories)
                }

                dreamControl

                Group {
                    if let error = store.memoryError {
                        ContentUnavailableView {
                            Label("Memories unavailable", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(error)
                        } actions: {
                            Button("Retry", action: refresh)
                        }
                    } else if store.isLoadingMemories && store.memories.isEmpty {
                        ProgressView("Loading memories…")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if store.memories.isEmpty {
                        ContentUnavailableView(
                            query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No Memories Yet" : "No Matching Memories",
                            systemImage: "brain",
                            description: Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? "Add a preference or fact for Railgun to remember."
                                : "Try a different search term.")
                        )
                    } else {
                        List(store.memories) { memory in
                            RailgunMemoryRow(
                                memory: memory,
                                isDisabled: store.isMutatingMemory,
                                edit: { editor = .edit(memory) },
                                delete: { deletionTarget = memory }
                            )
                        }
                        .listStyle(.inset)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(RailgunSpacing.layout.points)
            .navigationTitle("Manage Memories")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("New Memory", systemImage: "plus") {
                        editor = .create
                    }
                    .disabled(store.isMutatingMemory)
                }
            }
        }
        .frame(minWidth: 720, minHeight: 600)
        .task { await store.loadMemories(query: query) }
        .sheet(item: $editor) { editor in
            RailgunMemoryEditor(
                editor: editor,
                isSaving: store.isMutatingMemory,
                save: { content, category in
                    if await store.saveMemory(editor.memory, content: content, category: category, query: query) {
                        self.editor = nil
                    }
                },
                cancel: { self.editor = nil }
            )
        }
        .confirmationDialog(
            "Delete this memory?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: deletionTarget
        ) { memory in
            Button("Delete Memory", role: .destructive) {
                Task {
                    if await store.deleteMemory(memory, query: query) {
                        deletionTarget = nil
                    }
                }
            }
            .disabled(store.isMutatingMemory)
        } message: { _ in
            Text("This action cannot be undone.")
        }
    }

    private var dreamControl: some View {
        HStack(alignment: .center, spacing: RailgunSpacing.standard.points) {
            VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
                Label("Dream", systemImage: "sparkles")
                    .font(RailgunFont.interface(.body, weight: .semibold))
                Text(dreamDescription)
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)
                if let result = store.dreamResult {
                    Text("\(result.status.rawValue.capitalized): \(result.beforeCount) → \(result.afterCount) memories")
                        .font(RailgunFont.interface(.caption))
                        .foregroundStyle(RailgunColorRole.secondaryText.color)
                }
                if let error = store.dreamError {
                    Text(error)
                        .font(RailgunFont.interface(.caption))
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            Button(store.isRunningDream ? "Dreaming…" : "Run Dream") {
                Task { await store.runDream(query: query) }
            }
            .disabled(store.isRunningDream || store.isMutatingMemory || store.memoryCount < 5)
        }
        .padding(RailgunSpacing.standard.points)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityIdentifier("personalization-run-dream")
    }

    private var dreamDescription: String {
        store.memoryCount < 5
            ? "\(5 - store.memoryCount) more memories needed."
            : "Consolidate memories and promote stable preferences."
    }

    private func refresh() {
        Task { await store.loadMemories(query: query) }
    }
}

private enum MemoryEditor: Identifiable {
    case create
    case edit(RailgunAgentMemory)

    var id: String {
        switch self {
        case .create: "create"
        case let .edit(memory): memory.id
        }
    }

    var memory: RailgunAgentMemory? {
        switch self {
        case .create: nil
        case let .edit(memory): memory
        }
    }
}

private struct RailgunMemoryRow: View {
    let memory: RailgunAgentMemory
    let isDisabled: Bool
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RailgunSpacing.standard.points) {
            VStack(alignment: .leading, spacing: RailgunSpacing.compact.points) {
                Text(memory.category.uppercased())
                    .font(RailgunFont.interface(.caption, weight: .semibold))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)
                Text(memory.content)
                    .textSelection(.enabled)
                Text(memory.createdAt, format: .dateTime.year().month().day().hour().minute())
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)
            }
            Spacer(minLength: 16)
            Menu {
                Button("Edit", action: edit)
                Button("Delete", role: .destructive, action: delete)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .disabled(isDisabled)
        }
        .padding(RailgunSpacing.standard.points)
    }
}

private struct RailgunMemoryEditor: View {
    let editor: MemoryEditor
    let isSaving: Bool
    let save: (String, String) async -> Void
    let cancel: () -> Void
    @State private var content: String
    @State private var category: String

    init(
        editor: MemoryEditor,
        isSaving: Bool,
        save: @escaping (String, String) async -> Void,
        cancel: @escaping () -> Void
    ) {
        self.editor = editor
        self.isSaving = isSaving
        self.save = save
        self.cancel = cancel
        _content = State(initialValue: editor.memory?.content ?? "")
        _category = State(initialValue: editor.memory?.category ?? "fact")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
            Text(editor.memory == nil ? "New Memory" : "Edit Memory")
                .font(RailgunFont.interface(.title2, weight: .semibold))
            TextField("Category", text: $category)
            TextEditor(text: $content)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 160)
                .padding(8)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("Memory content")
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .disabled(isSaving)
                Button(isSaving ? "Saving…" : "Save") {
                    Task { await save(content, category) }
                }
                .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(RailgunSpacing.layout.points)
        .frame(width: 520)
    }
}
