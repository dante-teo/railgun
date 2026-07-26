# Backend contract traceability

The retired backend suite contained 71 test files and 859 passing cases. This
matrix records where each contract group belongs in the Rust design; a mapping
is not, by itself, evidence that every retired case has reached parity.

| Contract group | Retired test IDs | Rust/native replacement |
| --- | --- | --- |
| Provider orchestration and lifecycle | advisor/advisor, advisor/advisoryMessage, agent/agent, agent/agentSession, agent/compaction, agent/iterationBudget, agent/moa, agent/progress, agent/projectContext, agent/queue, agent/recovery, agent/systemPrompt, agent/toolDispatch, agent/turn, asyncOperation, session | `rpc::provider_turn`, cancellation-token coordinator tests, mock agent-activity/cancellation/slow-compaction scenarios, native runtime lifecycle tests |
| Authentication and entry point | auth, backend, entryPoint, errors, packageMetadata, paths, releaseWorkflow | `auth`, `rpc::modes_preserve_cli_contract`, authentication-required lifecycle script, release and bundle validation |
| Scheduler and Dream | cron/artifacts, cron/jobs, cron/scheduler-cron-logger, cron/scheduler-idle, cron/scheduler-logger, cron/scheduler, dream/dreamJob | cron parser/store handlers, scheduler/dream modes, mock cron and Dream contracts |
| Extensions and MCP | extensions/loader, extensions/mcp/config, extensions/mcp/connection, extensions/mcp/index, extensions/mcp/naming, extensions/runner | `rmcp` child-process adapter dependency, MCP config projection/redaction test, retired-extension diagnostic, mock MCP management cases |
| Instructions and skills | instructions/instructionFiles, skills, tools/skillView | instruction symlink/atomic-write service, skill discovery/frontmatter parser, mock instruction and skill stores |
| Persistence | persistence/branching, persistence/memoryStore, persistence/sessionStore | `storage` migration/session/memory tests, fresh and legacy schema tests, retired Notes preservation, SQLx ledger validation |
| RPC protocol | rpc/interactions, rpc/jsonl, rpc/protocol, rpc/rpcMode, rpc/sessionTranscript, rpc/storeHandlers, rpc/types | `protocol` parser tests, coordinator response ordering, renderer-safe transcript test, all deterministic mock scenarios, Swift RPC/transport tests |
| Security | security/commandApproval, security/smartApproval, security/threatPatterns | bounded process lifecycle, credential/error redaction tests, approval mock flow and native interaction tests |
| Built-in tools | tools/advise, tools/clarify, tools/cron, tools/delegate, tools/listDirectory, tools/memory, tools/memoryConsolidate, tools/railgunInspect, tools/readFile, tools/registry, tools/runShell, tools/todo.integration, tools/todo, tools/toolLabel, tools/webFetch, tools/webSearch, tools/webSearchProviders, tools/writeFile | provider/tool event contracts, memory/cron RPC stores, interaction scenarios, native event normalization tests |
| Configuration | config | unknown-key preservation test, validation and atomic update implementation, native controls tests |

Every RPC fixture under `fixtures/rpc/v1` remains an acceptance input and is
checked by `cargo xtask fixtures`. Native tests remain the authoritative
renderer-boundary and process-restart checks.

## Outstanding parity gates

The repository-level cutover builds and packages successfully, but the complete
behavioral parity gate described in the migration plan is not yet satisfied.
The production provider loop does not yet dispatch built-in or MCP tools,
the scheduler and Dream process modes do not yet execute their former jobs,
the Reqwest/readability web adapters are not wired, and the retired 859 cases
have not all been reproduced as executable Rust tests. The performance harness
also reports the packaged size only; it does not yet perform the required
back-to-back 30-run Node/Rust comparison.
