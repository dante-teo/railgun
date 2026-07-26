#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Scenario {
    ReadyIdle,
    AuthenticationRequired,
    DelayedStartup,
    CommandRejection,
    MalformedOutput,
    CrashBeforeReady,
    DisconnectAfterReady,
    HandshakeFailure,
    EmptyStores,
    StoreError,
    Approval,
    Clarification,
    ClarificationChoice,
    ClarificationFreeText,
    Cancellation,
    AgentActivity,
    EmptyModelCatalog,
    SlowCompaction,
}

impl Scenario {
    pub(crate) const ALL: [Self; 18] = [
        Self::ReadyIdle,
        Self::AuthenticationRequired,
        Self::DelayedStartup,
        Self::CommandRejection,
        Self::MalformedOutput,
        Self::CrashBeforeReady,
        Self::DisconnectAfterReady,
        Self::HandshakeFailure,
        Self::EmptyStores,
        Self::StoreError,
        Self::Approval,
        Self::Clarification,
        Self::ClarificationChoice,
        Self::ClarificationFreeText,
        Self::Cancellation,
        Self::AgentActivity,
        Self::EmptyModelCatalog,
        Self::SlowCompaction,
    ];

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|scenario| scenario.id() == value)
    }

    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::ReadyIdle => "ready-idle",
            Self::AuthenticationRequired => "authentication-required",
            Self::DelayedStartup => "delayed-startup",
            Self::CommandRejection => "command-rejection",
            Self::MalformedOutput => "malformed-output",
            Self::CrashBeforeReady => "crash-before-ready",
            Self::DisconnectAfterReady => "disconnect-after-ready",
            Self::HandshakeFailure => "handshake-failure",
            Self::EmptyStores => "empty-stores",
            Self::StoreError => "store-error",
            Self::Approval => "approval",
            Self::Clarification => "clarification",
            Self::ClarificationChoice => "clarification-choice",
            Self::ClarificationFreeText => "clarification-free-text",
            Self::Cancellation => "cancellation",
            Self::AgentActivity => "agent-activity",
            Self::EmptyModelCatalog => "empty-model-catalog",
            Self::SlowCompaction => "slow-compaction",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trips_every_unique_cli_id() {
        let ids = Scenario::ALL.map(Scenario::id);
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            ids.len()
        );
        for (scenario, id) in Scenario::ALL.into_iter().zip(ids) {
            assert_eq!(Scenario::parse(id), Some(scenario));
        }
        assert_eq!(Scenario::parse("unknown"), None);
    }
}
