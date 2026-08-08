import Foundation

/// Metadata exposed by the skill list without loading the instruction body.
public struct RailgunSkillSummary: Identifiable, Sendable, Equatable {
    public let name: String
    public let description: String
    public let isModelInvocationDisabled: Bool

    public var id: String { name }

    public init(name: String, description: String, isModelInvocationDisabled: Bool) {
        self.name = name
        self.description = description
        self.isModelInvocationDisabled = isModelInvocationDisabled
    }
}

/// A validated skill detail returned by `skill_get` and mutation commands.
public struct RailgunSkillDetail: Identifiable, Sendable, Equatable {
    public let name: String
    public let description: String
    public let body: String
    public let isModelInvocationDisabled: Bool

    public var id: String { name }

    public init(
        name: String,
        description: String,
        body: String,
        isModelInvocationDisabled: Bool
    ) {
        self.name = name
        self.description = description
        self.body = body
        self.isModelInvocationDisabled = isModelInvocationDisabled
    }

    public var summary: RailgunSkillSummary {
        .init(
            name: name,
            description: description,
            isModelInvocationDisabled: isModelInvocationDisabled
        )
    }
}
