import Darwin
import Foundation

enum RailgunLegacyBackgroundMode: String, Equatable {
    case scheduler
    case dream
}

enum RailgunLegacyBackgroundInvocation {
    static func mode(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) -> RailgunLegacyBackgroundMode? {
        guard environment["ELECTRON_RUN_AS_NODE"] == "1",
              arguments.dropFirst().contains(where: { $0.hasSuffix("/backend.js") }),
              let requestedMode = arguments.last
        else {
            return nil
        }
        return RailgunLegacyBackgroundMode(rawValue: requestedMode)
    }

    static func replaceProcessIfNeeded(
        resourcesDirectory: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) {
        guard let mode = mode(environment: environment, arguments: arguments) else { return }

        let backend = resourcesDirectory
            .appendingPathComponent("backend/railgun-backend")
            .standardizedFileURL
        var processArguments: [UnsafeMutablePointer<CChar>?] = [
            strdup(backend.path),
            strdup(mode.rawValue),
            nil,
        ]
        defer {
            for pointer in processArguments {
                if let pointer {
                    free(UnsafeMutableRawPointer(pointer))
                }
            }
        }
        guard let executable = processArguments[0] else { _exit(127) }
        processArguments.withUnsafeMutableBufferPointer { buffer in
            _ = execv(executable, buffer.baseAddress)
        }
        _exit(127)
    }
}

enum RailgunAppRuntime {
    static func isRunningTests(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isXCTestLoaded: Bool = NSClassFromString("XCTestCase") != nil
    ) -> Bool {
        isXCTestLoaded
            || environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
    }
}
