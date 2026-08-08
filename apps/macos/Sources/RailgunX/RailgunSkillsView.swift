import RailgunUI
import RailgunTransport
import SwiftUI

struct RailgunSkillsView: View {
    @Bindable private var store: RailgunSkillsStore
    @State private var query = ""
    @State private var selection: String?
    @State private var editor: RailgunSkillEditor?
    @State private var deletionTarget: RailgunSkillSummary?

    init(store: RailgunSkillsStore) {
        _store = Bindable(store)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let error = store.error, !store.skills.isEmpty {
                HStack(spacing: RailgunSpacing.standard.points) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(RailgunFont.interface(.callout))
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Retry") { Task { await store.retry() } }
                }
                .padding(.horizontal, RailgunSpacing.layout.points)
                .padding(.vertical, RailgunSpacing.compact.points)
                .background(.red.opacity(0.06))
                Divider()
            }
            if let error = store.error, store.skills.isEmpty {
                unavailable("Skills unavailable", message: error) {
                    Task { await store.retry() }
                }
            } else if store.isLoading && store.skills.isEmpty {
                ProgressView("Loading skills…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.skills.isEmpty {
                ContentUnavailableView {
                    Label("No Skills Yet", systemImage: "wand.and.stars")
                } description: {
                    Text("Create a skill to give Railgun reusable instructions for a task.")
                } actions: {
                    Button("New Skill", systemImage: "plus") { editor = .create }
                }
            } else {
                HStack(spacing: 0) {
                    skillList
                        .frame(minWidth: 260, idealWidth: 300, maxWidth: 360)
                    Divider()
                    detail
                }
            }
        }
        .navigationTitle("Skills")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Skill", systemImage: "plus") {
                    editor = .create
                }
                .disabled(store.isMutating)
                .accessibilityIdentifier("new-skill")
            }
        }
        .task {
            await store.load()
            if selection == nil {
                selection = store.skills.first?.name
            }
        }
        .task(id: selection) {
            guard let selection else {
                store.clearSelection()
                return
            }
            await store.loadDetail(name: selection)
        }
        .onChange(of: store.skills) { _, skills in
            let names = Set(skills.map(\.name))
            if let selectedSkill = store.selectedSkill, names.contains(selectedSkill.name) {
                selection = selectedSkill.name
            } else if selection.map({ !names.contains($0) }) ?? true {
                selection = skills.first?.name
            }
        }
        .sheet(item: $editor) { editor in
            RailgunSkillEditorView(
                editor: editor,
                store: store
            )
        }
        .confirmationDialog(
            "Delete skill?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { skill in
            Button("Delete \(skill.name)", role: .destructive) {
                Task {
                    if await store.delete(name: skill.name), selection == skill.name {
                        selection = store.skills.first?.name
                    }
                    deletionTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { deletionTarget = nil }
        } message: { skill in
            Text("This removes the managed skill file for \(skill.name). Asset files in its folder are left untouched.")
        }
        .frame(minWidth: 700, minHeight: 480)
    }

    private var skillList: some View {
        List(selection: $selection) {
            ForEach(filteredSkills) { skill in
                HStack(spacing: 10) {
                    Image(systemName: skill.isModelInvocationDisabled ? "eye.slash" : "wand.and.stars")
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skill.name)
                            .lineLimit(1)
                        Text(skill.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .tag(Optional(skill.name))
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $query, prompt: "Filter skills")
        .overlay {
            if filteredSkills.isEmpty {
                ContentUnavailableView("No Matching Skills", systemImage: "magnifyingglass")
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let selected = store.selectedSkill, selected.name == selection {
            ScrollView {
                VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(selected.name)
                                .font(RailgunFont.interface(.title2, weight: .semibold))
                            Text(selected.description)
                                .foregroundStyle(RailgunColorRole.secondaryText.color)
                        }
                        Spacer()
                        Menu {
                            Button("Edit", systemImage: "pencil") {
                                editor = .edit(selected)
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                deletionTarget = selected.summary
                            }
                        } label: {
                            Label("Skill actions", systemImage: "ellipsis.circle")
                        }
                        .menuStyle(.borderlessButton)
                    }

                    Label(
                        selected.isModelInvocationDisabled ? "Manual invocation only" : "Available to the model",
                        systemImage: selected.isModelInvocationDisabled ? "eye.slash" : "eye"
                    )
                    .font(RailgunFont.interface(.callout))
                    .foregroundStyle(RailgunColorRole.secondaryText.color)

                    Divider()

                    Text("Instructions")
                        .font(RailgunFont.interface(.headline, weight: .semibold))
                    RailgunMarkdownMessage(markdown: selected.body)
                        .padding(RailgunSpacing.standard.points)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .padding(RailgunSpacing.layout.points)
            }
        } else if store.isLoadingDetail {
            ProgressView("Loading skill…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("Select a Skill", systemImage: "wand.and.stars")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var filteredSkills: [RailgunSkillSummary] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return store.skills }
        return store.skills.filter {
            $0.name.localizedCaseInsensitiveContains(normalized)
                || $0.description.localizedCaseInsensitiveContains(normalized)
        }
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

private struct RailgunSkillEditor: Identifiable {
    let id = UUID()
    let skill: RailgunSkillDetail?

    static let create = Self(skill: nil)

    static func edit(_ skill: RailgunSkillDetail) -> Self {
        Self(skill: skill)
    }
}

private struct RailgunSkillEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable private var store: RailgunSkillsStore
    private let editor: RailgunSkillEditor
    @State private var name: String
    @State private var description: String
    @State private var bodyText: String
    @State private var isModelInvocationDisabled: Bool

    init(editor: RailgunSkillEditor, store: RailgunSkillsStore) {
        self.editor = editor
        _store = Bindable(store)
        _name = State(initialValue: editor.skill?.name ?? "")
        _description = State(initialValue: editor.skill?.description ?? "")
        _bodyText = State(initialValue: editor.skill?.body ?? "")
        _isModelInvocationDisabled = State(initialValue: editor.skill?.isModelInvocationDisabled ?? false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RailgunSpacing.standard.points) {
            Text(editor.skill == nil ? "New Skill" : "Edit Skill")
                .font(RailgunFont.interface(.title2, weight: .semibold))

            Form {
                TextField("Name", text: $name)
                    .disabled(editor.skill != nil)
                    .help("1–64 lowercase letters, numbers, or hyphens")
                TextField("Description", text: $description)
                Toggle("Available to the model", isOn: Binding(
                    get: { !isModelInvocationDisabled },
                    set: { isModelInvocationDisabled = !$0 }
                ))
                VStack(alignment: .leading, spacing: 6) {
                    Text("Instructions")
                    TextEditor(text: $bodyText)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 260)
                        .padding(6)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }

            if let validationMessage {
                Label(validationMessage, systemImage: "exclamationmark.triangle")
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.red)
            }
            if let error = store.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button(store.isMutating ? "Saving…" : "Save") {
                    Task {
                        let succeeded: Bool
                        if editor.skill == nil {
                            succeeded = await store.create(
                                name: name,
                                description: description,
                                body: bodyText,
                                isModelInvocationDisabled: isModelInvocationDisabled
                            )
                        } else {
                            succeeded = await store.update(
                                name: name,
                                description: description,
                                body: bodyText,
                                isModelInvocationDisabled: isModelInvocationDisabled
                            )
                        }
                        if succeeded { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(validationMessage != nil || store.isMutating)
            }
        }
        .padding(RailgunSpacing.layout.points)
        .frame(minWidth: 620, minHeight: 520)
    }

    private var validationMessage: String? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name == trimmedName,
              !trimmedName.isEmpty,
              trimmedName.utf8.count <= RailgunRPCValidationLimits.skillName,
              trimmedName.allSatisfy({ ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-" })
        else { return "Name must use 1–64 lowercase letters, numbers, or hyphens." }
        guard !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              description.utf8.count <= RailgunRPCValidationLimits.skillDescription
        else { return "Description is required and must be at most 1,024 bytes." }
        guard bodyText.utf8.count <= RailgunRPCValidationLimits.skillBody else {
            return "Instructions must be at most 200,000 bytes."
        }
        return nil
    }
}
