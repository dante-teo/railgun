import Foundation
import XCTest

public struct TemporaryRailgunHome: Sendable {
    public let url: URL

    public var railgunDirectory: URL {
        url.appendingPathComponent(".railgun", isDirectory: true)
    }

    public var environment: [String: String] {
        ["HOME": url.path]
    }

    public init() throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
        let url = temporaryDirectory.appendingPathComponent(
            "railgunx-test-home-\(UUID().uuidString)",
            isDirectory: true
        )

        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: url.appendingPathComponent(".railgun"), withIntermediateDirectories: false)
        self.url = url
    }

    public func remove() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}

public enum RPCFixtureTerminalState: String, Codable, Sendable {
    case open
    case eof
}

public struct RPCFixtureOutput: Sendable, Equatable {
    public let rawBytes: Data
    public let delayMilliseconds: Int
}

public struct RPCFixtureStep: Sendable, Equatable {
    public let expectedRequest: Data
    public let outputs: [RPCFixtureOutput]
    public let terminalState: RPCFixtureTerminalState
}

public struct RPCFixtureScenario: Sendable, Equatable {
    public let id: String
    public let steps: [RPCFixtureStep]
}

public struct RPCFixtureCorpus: Sendable, Equatable {
    public let version: Int
    public let scenarios: [RPCFixtureScenario]

    public func scenario(id: String) throws -> RPCFixtureScenario {
        guard let scenario = scenarios.first(where: { $0.id == id }) else {
            throw RPCFixtureError.missingScenario(id)
        }
        return scenario
    }
}

public enum RPCFixtureError: Error, Equatable {
    case missingManifest
    case missingScenario(String)
    case duplicateScenario(String)
    case invalidScenario(String)
    case missingFile(String)
}

public enum RPCFixtureLoader {
    public static func load(from bundle: Bundle) throws -> RPCFixtureCorpus {
        guard let manifestURL = bundle.url(forResource: "manifest", withExtension: "json") else {
            throw RPCFixtureError.missingManifest
        }

        let manifestData = try Data(contentsOf: manifestURL)
        let manifest = try JSONDecoder().decode(FixtureManifest.self, from: manifestData)
        let fixtureRoot = manifestURL.deletingLastPathComponent()
        let scenarios = try manifest.scenarios.map { try loadScenario($0, fixtureRoot: fixtureRoot) }
        let identifiers = scenarios.map(\.id)

        guard Set(identifiers).count == identifiers.count else {
            let duplicate = Dictionary(grouping: identifiers, by: { $0 })
                .first(where: { $0.value.count > 1 })?.key ?? "unknown"
            throw RPCFixtureError.duplicateScenario(duplicate)
        }

        return RPCFixtureCorpus(version: manifest.version, scenarios: scenarios)
    }

    private static func loadScenario(
        _ scenario: FixtureManifest.Scenario,
        fixtureRoot: URL
    ) throws -> RPCFixtureScenario {
        guard !scenario.id.isEmpty, !scenario.steps.isEmpty else {
            throw RPCFixtureError.invalidScenario(scenario.id)
        }

        let steps = try scenario.steps.map { step in
            let request = try loadFile(step.requestFile, fixtureRoot: fixtureRoot)
            guard isJSONLRequest(request), step.outputs.allSatisfy({ $0.delayMilliseconds >= 0 }) else {
                throw RPCFixtureError.invalidScenario(scenario.id)
            }
            let outputs = try step.outputs.map { output in
                RPCFixtureOutput(
                    rawBytes: try loadFile(output.file, fixtureRoot: fixtureRoot),
                    delayMilliseconds: output.delayMilliseconds
                )
            }
            return RPCFixtureStep(
                expectedRequest: request,
                outputs: outputs,
                terminalState: step.terminalState
            )
        }

        return RPCFixtureScenario(id: scenario.id, steps: steps)
    }

    private static func loadFile(_ path: String, fixtureRoot: URL) throws -> Data {
        let fileURL = fixtureRoot.appendingPathComponent(path).standardizedFileURL
        let rootPath = fixtureRoot.standardizedFileURL.path
        guard fileURL.path.hasPrefix("\(rootPath)/"), FileManager.default.fileExists(atPath: fileURL.path) else {
            throw RPCFixtureError.missingFile(path)
        }
        return try Data(contentsOf: fileURL)
    }
}

public struct ScriptedMockBackendReply: Sendable, Equatable {
    public let outputs: [RPCFixtureOutput]
    public let terminalState: RPCFixtureTerminalState
}

public enum ScriptedMockBackendError: Error, Equatable {
    case invalidJSONLRequest(index: Int)
    case unexpectedRequest(index: Int)
    case unexpectedRequestAfterCompletion
}

public actor ScriptedMockBackend {
    private let scenario: RPCFixtureScenario
    private var nextStepIndex = 0
    private var inputs: [Data] = []

    public init(scenario: RPCFixtureScenario) {
        self.scenario = scenario
    }

    public func receive(_ input: Data) throws -> ScriptedMockBackendReply {
        inputs.append(input)

        guard isJSONLRequest(input) else {
            throw ScriptedMockBackendError.invalidJSONLRequest(index: nextStepIndex)
        }
        guard nextStepIndex < scenario.steps.count else {
            throw ScriptedMockBackendError.unexpectedRequestAfterCompletion
        }

        let step = scenario.steps[nextStepIndex]
        guard step.expectedRequest == input else {
            throw ScriptedMockBackendError.unexpectedRequest(index: nextStepIndex)
        }

        nextStepIndex += 1
        return ScriptedMockBackendReply(outputs: step.outputs, terminalState: step.terminalState)
    }

    public func receivedInput() -> [Data] {
        inputs
    }

    public func remainingStepCount() -> Int {
        scenario.steps.count - nextStepIndex
    }
}

public extension XCTestCase {
    func temporaryRailgunHome() throws -> TemporaryRailgunHome {
        let home = try TemporaryRailgunHome()
        addTeardownBlock {
            try? home.remove()
        }
        return home
    }

    func rpcFixtureCorpus(bundle: Bundle? = nil) throws -> RPCFixtureCorpus {
        try RPCFixtureLoader.load(from: bundle ?? Bundle(for: type(of: self)))
    }

    func assertRPCFixtureCorpus(
        _ corpus: RPCFixtureCorpus,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(corpus.version, 1, file: file, line: line)
        XCTAssertEqual(Set(corpus.scenarios.map(\.id)).count, corpus.scenarios.count, file: file, line: line)
        XCTAssertTrue(
            corpus.scenarios.allSatisfy { scenario in
                !scenario.steps.isEmpty && scenario.steps.allSatisfy { step in
                    isJSONLRequest(step.expectedRequest) && step.outputs.allSatisfy { $0.delayMilliseconds >= 0 }
                }
            },
            file: file,
            line: line
        )
    }
}

private func isJSONLRequest(_ data: Data) -> Bool {
    guard data.last == UInt8(ascii: "\n") else { return false }
    let frame = Data(data.dropLast())
    guard let object = try? JSONSerialization.jsonObject(with: frame) else { return false }
    return object is [String: Any]
}

private struct FixtureManifest: Decodable {
    let version: Int
    let scenarios: [Scenario]

    struct Scenario: Decodable {
        let id: String
        let steps: [Step]
    }

    struct Step: Decodable {
        let requestFile: String
        let outputs: [Output]
        let terminalState: RPCFixtureTerminalState
    }

    struct Output: Decodable {
        let file: String
        let delayMilliseconds: Int
    }
}
