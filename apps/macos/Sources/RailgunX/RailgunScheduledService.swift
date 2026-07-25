import Foundation
import RailgunTransport

enum RailgunDestination: Equatable {
    case task
    case scheduled
}

enum RailgunScheduledRunStatus: String, Equatable, Sendable {
    case completed
    case incomplete
    case failed
}

struct RailgunScheduledJob: Equatable, Identifiable, Sendable {
    let id: String
    let schedule: String
    let prompt: String
    let lastRun: Date?
    let lastStatus: RailgunScheduledRunStatus?
    let lastError: String?

    func edited(prompt: String, schedule: String) -> Self {
        .init(id: id, schedule: schedule, prompt: prompt, lastRun: lastRun, lastStatus: lastStatus, lastError: lastError)
    }
}

enum RailgunScheduledForm {
    static let maximumPromptLength = 8_000
    static let maximumScheduleLength = 256

    static func normalized(prompt: String, schedule: String) -> (prompt: String, schedule: String) {
        (
            prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            schedule.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        )
    }

    static func validationMessage(prompt: String, schedule: String) -> String? {
        let value = normalized(prompt: prompt, schedule: schedule)
        guard !value.prompt.isEmpty else { return "Enter a prompt." }
        guard value.prompt.count <= maximumPromptLength else { return "The prompt is too long." }
        guard value.schedule.count <= maximumScheduleLength else { return "The schedule is too long." }
        guard value.schedule.split(separator: " ").count == 5 else {
            return "Use exactly five cron fields."
        }
        return nil
    }
}

struct RailgunScheduledState: Equatable {
    var jobs: [RailgunScheduledJob]
    var isLoading: Bool
    var isMutating: Bool
    var error: String?
    var generation: Int

    static let initial = Self(jobs: [], isLoading: false, isMutating: false, error: nil, generation: 0)
}

enum RailgunScheduledAction: Equatable {
    case loading(generation: Int)
    case loaded(generation: Int, jobs: [RailgunScheduledJob])
    case loadFailed(generation: Int, message: String)
    case mutationStarted
    case created(RailgunScheduledJob)
    case updated(RailgunScheduledJob)
    case removed(String)
    case mutationFailed(String)
}

enum RailgunScheduledReducer {
    static func reduce(_ state: RailgunScheduledState, _ action: RailgunScheduledAction) -> RailgunScheduledState {
        var next = state
        switch action {
        case let .loading(generation):
            next.generation = generation
            next.isLoading = true
            next.error = nil
        case let .loaded(generation, jobs):
            guard generation == state.generation, !state.isMutating else { return state }
            next.jobs = jobs
            next.isLoading = false
            next.error = nil
        case let .loadFailed(generation, message):
            guard generation == state.generation, !state.isMutating else { return state }
            next.isLoading = false
            next.error = message
        case .mutationStarted:
            next.generation += 1 // invalidate any list request that began before this mutation
            next.isLoading = false
            next.isMutating = true
            next.error = nil
        case let .created(job):
            next.jobs.append(job)
            next.jobs.sort { $0.prompt.localizedCaseInsensitiveCompare($1.prompt) == .orderedAscending }
            next.isLoading = false
            next.isMutating = false
        case let .updated(job):
            next.jobs = next.jobs.map { $0.id == job.id ? job : $0 }
            next.isLoading = false
            next.isMutating = false
        case let .removed(id):
            next.jobs.removeAll { $0.id == id }
            next.isLoading = false
            next.isMutating = false
        case let .mutationFailed(message):
            next.isLoading = false
            next.isMutating = false
            next.error = message
        }
        return next
    }
}

enum RailgunScheduledServiceError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case rejected(String)
}

actor RailgunScheduledService {
    typealias Request = @Sendable (RailgunRPCCommand) async throws -> RailgunRPCResponse

    private static let timeout: Duration = .seconds(15)
    private static let pageSize = 100
    private static let maximumJobs = 500
    private static let maximumIDLength = 256
    private static let maximumTimestampMilliseconds = 4_102_444_800_000 // 2100-01-01
    private static let maximumErrorLength = 240
    private let request: Request

    init(request: @escaping Request) { self.request = request }

    init(rpcClient: RailgunRPCClient) {
        self.init { command in try await rpcClient.request(command, timeout: Self.timeout) }
    }

    func list() async throws -> [RailgunScheduledJob] {
        var jobs: [RailgunScheduledJob] = []
        var cursor = 0
        while jobs.count < Self.maximumJobs {
            let response = try await perform(.cronList, fields: [
                "cursor": .number(Double(cursor)),
                "limit": .number(Double(Self.pageSize)),
                "maxPromptLength": .number(Double(RailgunScheduledForm.maximumPromptLength)),
            ])
            guard let object = response.data?.objectValue,
                  let rawJobs = object["jobs"], case let .array(page) = rawJobs,
                  page.count <= Self.pageSize
            else { throw RailgunScheduledServiceError.invalidResponse }
            let parsed = try page.map(parseJob)
            guard Set(parsed.map(\.id)).count == parsed.count,
                  Set(jobs.map(\.id)).isDisjoint(with: Set(parsed.map(\.id))),
                  jobs.count + parsed.count <= Self.maximumJobs
            else { throw RailgunScheduledServiceError.invalidResponse }
            jobs.append(contentsOf: parsed)
            guard let rawNext = object["nextCursor"] else { return jobs }
            guard !page.isEmpty, let next = rawNext.integerValue, next > cursor, next <= Self.maximumJobs else {
                throw RailgunScheduledServiceError.invalidResponse
            }
            cursor = next
        }
        throw RailgunScheduledServiceError.invalidResponse
    }

    func create(prompt: String, schedule: String) async throws -> RailgunScheduledJob {
        let form = try validatedForm(prompt: prompt, schedule: schedule)
        let id = try await requestMutation(.cronAdd, fields: [
            "prompt": .string(form.prompt), "schedule": .string(form.schedule), "includeJob": .bool(false),
        ])
        return .init(id: id, schedule: form.schedule, prompt: form.prompt, lastRun: nil, lastStatus: nil, lastError: nil)
    }

    func update(_ job: RailgunScheduledJob, prompt: String, schedule: String) async throws -> RailgunScheduledJob {
        let form = try validatedForm(prompt: prompt, schedule: schedule)
        let id = try await requestMutation(.cronUpdate, fields: [
            "jobId": .string(job.id),
            "patch": .object(["prompt": .string(form.prompt), "schedule": .string(form.schedule)]),
            "includeJob": .bool(false),
        ])
        guard id == job.id else { throw RailgunScheduledServiceError.invalidResponse }
        return job.edited(prompt: form.prompt, schedule: form.schedule)
    }

    func remove(_ job: RailgunScheduledJob) async throws {
        let response = try await perform(.cronRemove, fields: ["jobId": .string(job.id)])
        guard response.data == nil else { throw RailgunScheduledServiceError.invalidResponse }
    }

    private func validatedForm(prompt: String, schedule: String) throws -> (prompt: String, schedule: String) {
        let form = RailgunScheduledForm.normalized(prompt: prompt, schedule: schedule)
        guard RailgunScheduledForm.validationMessage(prompt: form.prompt, schedule: form.schedule) == nil else {
            throw RailgunScheduledServiceError.invalidRequest
        }
        return form
    }

    private func requestMutation(_ type: RailgunRPCCommandType, fields: [String: RailgunJSONValue]) async throws -> String {
        let response = try await perform(type, fields: fields)
        guard let data = response.data?.objectValue,
              Set(data.keys) == Set(["jobId"]),
              let id = validID(data["jobId"])
        else { throw RailgunScheduledServiceError.invalidResponse }
        return id
    }

    private func perform(_ type: RailgunRPCCommandType, fields: [String: RailgunJSONValue] = [:]) async throws -> RailgunRPCResponse {
        let command: RailgunRPCCommand
        do { command = try RailgunRPCCommand(type: type, fields: fields) }
        catch { throw RailgunScheduledServiceError.invalidRequest }
        let response: RailgunRPCResponse
        do { response = try await request(command) }
        catch { throw RailgunScheduledServiceError.rejected("The scheduled jobs request could not be completed.") }
        guard response.command == type.rawValue else { throw RailgunScheduledServiceError.invalidResponse }
        guard response.success else { throw RailgunScheduledServiceError.rejected(presentationMessage(response.error)) }
        return response
    }

    private func parseJob(_ value: RailgunJSONValue) throws -> RailgunScheduledJob {
        guard let object = value.objectValue,
              let id = validID(object["id"]),
              let schedule = object["schedule"]?.stringValue,
              let prompt = object["prompt"]?.stringValue,
              RailgunScheduledForm.validationMessage(prompt: prompt, schedule: schedule) == nil
        else { throw RailgunScheduledServiceError.invalidResponse }
        let lastRun = try timestamp(object["lastRun"])
        let status: RailgunScheduledRunStatus?
        if let rawStatus = object["lastStatus"] {
            guard rawStatus == .null || RailgunScheduledRunStatus(rawValue: rawStatus.stringValue ?? "") != nil else {
                throw RailgunScheduledServiceError.invalidResponse
            }
            status = rawStatus.stringValue.flatMap(RailgunScheduledRunStatus.init(rawValue:))
        } else {
            status = lastRun == nil ? nil : .completed
        }
        let rawError = object["lastError"]
        guard rawError == nil || rawError == .null || rawError?.stringValue != nil else {
            throw RailgunScheduledServiceError.invalidResponse
        }
        let error = status == .failed ? safeError(rawError?.stringValue) : nil
        return .init(id: id, schedule: RailgunScheduledForm.normalized(prompt: prompt, schedule: schedule).schedule, prompt: prompt, lastRun: lastRun, lastStatus: status, lastError: error)
    }

    private func validID(_ value: RailgunJSONValue?) -> String? {
        guard let value = value?.stringValue,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= Self.maximumIDLength
        else { return nil }
        return value
    }

    private func timestamp(_ value: RailgunJSONValue?) throws -> Date? {
        guard let value, value != .null else { return nil }
        guard let milliseconds = value.integerValue,
              milliseconds >= 0,
              milliseconds <= Self.maximumTimestampMilliseconds
        else { throw RailgunScheduledServiceError.invalidResponse }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
    }

    private func safeError(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return String(RailgunRPCRedactor.redact(text: value).prefix(Self.maximumErrorLength))
    }

    private func presentationMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else { return "The scheduled jobs request was rejected." }
        return String(RailgunRPCRedactor.redact(text: message).prefix(Self.maximumErrorLength))
    }
}

@MainActor
final class RailgunScheduledCoordinator {
    private let store: RailgunAppStore
    private let service: RailgunScheduledService

    init(store: RailgunAppStore, service: RailgunScheduledService) {
        self.store = store
        self.service = service
    }

    func refresh() async {
        let generation = store.state.scheduled.generation + 1
        store.send(.scheduled(.loading(generation: generation)))
        do {
            let jobs = try await service.list()
            store.send(.scheduled(.loaded(generation: generation, jobs: jobs)))
        } catch {
            store.send(.scheduled(.loadFailed(
                generation: generation,
                message: presentationMessage(for: error)
            )))
        }
    }

    func create(prompt: String, schedule: String) async -> Bool {
        await performMutation {
            .created(try await self.service.create(prompt: prompt, schedule: schedule))
        }
    }

    func update(_ job: RailgunScheduledJob, prompt: String, schedule: String) async -> Bool {
        await performMutation {
            .updated(try await self.service.update(job, prompt: prompt, schedule: schedule))
        }
    }

    func remove(_ job: RailgunScheduledJob) async -> Bool {
        await performMutation {
            try await self.service.remove(job)
            return .removed(job.id)
        }
    }

    private func performMutation(
        _ operation: @MainActor () async throws -> RailgunScheduledAction
    ) async -> Bool {
        guard !store.state.scheduled.isMutating else { return false }
        store.send(.scheduled(.mutationStarted))
        do {
            store.send(.scheduled(try await operation()))
            return true
        } catch {
            store.send(.scheduled(.mutationFailed(presentationMessage(for: error))))
            return false
        }
    }

    private func presentationMessage(for error: Error) -> String {
        switch error {
        case RailgunScheduledServiceError.invalidRequest: "Enter a prompt and a five-field cron schedule."
        case RailgunScheduledServiceError.invalidResponse: "The backend returned invalid scheduled job data."
        case let RailgunScheduledServiceError.rejected(message): message
        default: "The scheduled jobs request could not be completed."
        }
    }
}
