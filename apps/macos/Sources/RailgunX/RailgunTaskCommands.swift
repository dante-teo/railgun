import SwiftUI

struct RailgunTaskCommandAvailability: Equatable {
    let canCreateTask: Bool
}

struct RailgunTaskCommandActions {
    let availability: RailgunTaskCommandAvailability
    let createTask: () -> Void
}

private struct RailgunTaskCommandActionsKey: FocusedValueKey {
    typealias Value = RailgunTaskCommandActions
}

extension FocusedValues {
    var railgunTaskCommandActions: RailgunTaskCommandActions? {
        get { self[RailgunTaskCommandActionsKey.self] }
        set { self[RailgunTaskCommandActionsKey.self] = newValue }
    }
}

struct RailgunTaskCommands: Commands {
    @FocusedValue(\.railgunTaskCommandActions) private var taskActions
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Task") {
                taskActions?.createTask()
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(taskActions?.availability.canCreateTask != true)
        }

        CommandMenu("Task") {
            Button("Task") {
                openWindow(id: AppLifecycleConfiguration.primary.primaryWindowRestorationIdentifier)
            }
            .keyboardShortcut("1", modifiers: .command)
        }

        CommandGroup(replacing: .appSettings) {
            Button("Settings") {
                openSettings()
            }
            .keyboardShortcut(",", modifiers: .command)
        }
    }
}
