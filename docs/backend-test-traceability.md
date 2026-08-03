# Backend contract traceability

The retired backend suite contained 71 test files and 859 passing cases. This
matrix records where each contract group belongs in the Rust design; a mapping
is not, by itself, evidence that every retired case has reached parity.

| Contract group | Retired test IDs | Rust/native replacement |
| --- | --- | --- |
| Provider orchestration and lifecycle | advisor/advisor, advisor/advisoryMessage, agent/agent, agent/agentSession, agent/compaction, agent/iterationBudget, agent/moa, agent/progress, agent/projectContext, agent/queue, agent/recovery, agent/systemPrompt, agent/toolDispatch, agent/turn, asyncOperation, session | iterative `rpc::provider_turn` tool dispatch and transcript persistence, cancellation-token coordinator tests, advisor single-note path, mock agent-activity/cancellation/slow-compaction scenarios, native runtime lifecycle tests |
| Authentication and entry point | auth, backend, entryPoint, errors, packageMetadata, paths, releaseWorkflow | `auth`, `rpc::modes_preserve_cli_contract`, authentication-required lifecycle script, native browser login/logout/re-login and reconnect-failure tests, release and bundle validation |
| Scheduler and Dream | cron/artifacts, cron/jobs, cron/scheduler-cron-logger, cron/scheduler-idle, cron/scheduler-logger, cron/scheduler, dream/dreamJob | five-field cron validation, minute-boundary scheduler and persisted scheduled deliveries, direct-backend LaunchAgent install/repair/uninstall and legacy-agent migration tests, `dream_run` duplicate consolidation/progress tests, mock cron and Dream contracts |
| Extensions and MCP | extensions/loader, extensions/mcp/config, extensions/mcp/connection, extensions/mcp/index, extensions/mcp/naming, extensions/runner | `rmcp` child-process adapter dependency, MCP config projection/redaction test, retired-extension diagnostic, mock MCP management cases |
| Instructions and skills | instructions/instructionFiles, skills, tools/skillView | instruction symlink/atomic-write service, skill discovery/frontmatter parser, mock instruction and skill stores |
| Persistence | persistence/branching, persistence/memoryStore, persistence/sessionStore | `storage` migration/session/memory tests, fresh and legacy schema tests, retired Notes preservation, SQLx ledger validation |
| RPC protocol | rpc/interactions, rpc/jsonl, rpc/protocol, rpc/rpcMode, rpc/sessionTranscript, rpc/storeHandlers, rpc/types | `protocol` parser tests, coordinator response ordering, renderer-safe transcript test, all deterministic mock scenarios, Swift RPC/transport tests |
| Security | security/commandApproval, security/smartApproval, security/threatPatterns | normalized shell policy and per-session approval tests, protected file-boundary tests, public-web/DNS-pinning tests, credential/error redaction tests, approval mock flow and native interaction tests |
| Built-in tools | tools/advise, tools/clarify, tools/cron, tools/delegate, tools/listDirectory, tools/memory, tools/memoryConsolidate, tools/railgunInspect, tools/readFile, tools/registry, tools/runShell, tools/todo.integration, tools/todo, tools/toolLabel, tools/webFetch, tools/webSearch, tools/webSearchProviders, tools/writeFile | registry/dispatch contract tests for the restored built-ins, todo/memory/cron RPC stores, desktop interaction tests, bounded delegation, web safety, and native event normalization tests |
| Configuration | config | unknown-key preservation test, validation and atomic update implementation, native controls tests |

Every RPC fixture under `fixtures/rpc/v1` remains an acceptance input and is
checked by `cargo xtask fixtures`. Native tests remain the authoritative
renderer-boundary and process-restart checks.

## Outstanding parity gates

The restoration scope now dispatches the built-in tools in the production
provider loop, executes scheduler and Dream jobs, and provides bounded public
web search/fetch. MCP and JavaScript extension execution remain intentionally
out of scope. The retired 859 cases have not all been reproduced as executable
Rust tests, and the performance harness still reports packaged size only rather
than performing the required back-to-back 30-run Node/Rust comparison.
