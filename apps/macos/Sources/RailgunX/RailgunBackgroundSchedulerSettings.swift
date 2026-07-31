import RailgunServices
import RailgunUI
import SwiftUI

struct RailgunBackgroundSchedulerSettings: View {
    let service: RailgunBackgroundSchedulerService?

    @State private var status: RailgunBackgroundSchedulerStatus?
    @State private var isMutating = false
    @State private var errorMessage: String?

    var body: some View {
        Section {
            LabeledContent("Status") {
                Label(statusTitle, systemImage: statusSystemImage)
                    .foregroundStyle(statusColor)
            }

            HStack {
                switch status {
                case .notInstalled:
                    Button("Install", systemImage: "arrow.down.circle") {
                        install()
                    }
                case .repairNeeded, .installed(running: false):
                    Button("Repair", systemImage: "wrench.and.screwdriver") {
                        install()
                    }
                    Button("Uninstall", role: .destructive) {
                        uninstall()
                    }
                case .installed(running: true):
                    Button("Uninstall", role: .destructive) {
                        uninstall()
                    }
                case nil:
                    EmptyView()
                }

                if isMutating {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .disabled(isMutating || service == nil)

            if let errorMessage {
                Text(errorMessage)
                    .font(RailgunFont.interface(.caption))
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Background Scheduling")
        } footer: {
            Text(
                "Runs scheduled prompts and private nightly maintenance after Railgun quits. "
                    + "The background scheduler never opens the app."
            )
        }
        .task {
            await refresh()
        }
    }

    private var statusTitle: String {
        guard service != nil else { return "Unavailable in this build" }
        return switch status {
        case .notInstalled: "Not installed"
        case .installed(running: true): "Installed and running"
        case .installed(running: false): "Installed but not running"
        case .repairNeeded: "Repair needed"
        case nil: "Checking…"
        }
    }

    private var statusSystemImage: String {
        guard service != nil else { return "minus.circle" }
        return switch status {
        case .notInstalled: "circle"
        case .installed(running: true): "checkmark.circle.fill"
        case .installed(running: false), .repairNeeded: "exclamationmark.triangle.fill"
        case nil: "clock"
        }
    }

    private var statusColor: Color {
        switch status {
        case .installed(running: true): .green
        case .installed(running: false), .repairNeeded: .orange
        default: .secondary
        }
    }

    private func install() {
        guard let service else { return }
        isMutating = true
        errorMessage = nil
        Task {
            do {
                status = try await service.install()
            } catch {
                errorMessage = "Railgun could not install the background scheduler."
            }
            isMutating = false
        }
    }

    private func uninstall() {
        guard let service else { return }
        isMutating = true
        errorMessage = nil
        Task {
            do {
                status = try await service.uninstall()
            } catch {
                errorMessage = "Railgun could not uninstall the background scheduler."
            }
            isMutating = false
        }
    }

    private func refresh() async {
        guard let service else { return }
        do {
            status = try await service.status()
            errorMessage = nil
        } catch {
            errorMessage = "Railgun could not read the background scheduler status."
        }
    }
}
