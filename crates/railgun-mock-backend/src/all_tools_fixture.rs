use serde_json::{Value, json};

pub(super) const ALL_TOOLS_DEMO_SESSION_ID: &str = "mock-session-all-tools";

const PRIVATE_BETA_REPORT: &str = r#"# Railgun private-beta readiness brief

Date: 6 August 2026
Audience: invited testers under NDA
Decision: GO WITH GATES

## Scope

This brief covers the Electron macOS app, its bundled arm64 backend, and the complete desktop regression surface. It does not authorize a public beta, Homebrew distribution, or stable production rollout.

## Evidence reviewed

- The repository release guide and desktop verification contract.
- The configured Railgun diagnostic state and saved release preferences.
- Independent accessibility and release-safety reviews delegated during this task.
- Apple's current notarization guidance for software distributed outside the Mac App Store.
- A clean worktree, successful desktop typecheck, and focused mock-backend contract tests.

## Release gates

1. Run every command in `docs/RELEASING.md` from a clean `main` checkout.
2. Package, sign, notarize, staple, and validate the Apple-silicon Electron app and bundled backend.
3. Confirm VoiceOver names, keyboard traversal, focus restoration, and reduced-motion behavior for the task transcript and interaction rows.
4. Verify that restored transcripts never expose thinking signatures, tool arguments, or raw tool-result payloads.
5. Confirm the invitation and rollback owner before distributing the first build.

## Independent review findings

The accessibility review found no release-blocking issue in the documented flow, but requires a manual VoiceOver pass on approval, clarification, failed-tool, and long-result states. The release-safety review confirmed that the Electron workflow covers Developer ID signing, notarization, stapling, Gatekeeper assessment, archive layout, update metadata, and compatibility-appcast validation.

## External distribution guidance

Apple's current guidance still requires Developer ID signing and notarization for software distributed outside the Mac App Store. The shipped artifact must be checked after stapling; a successful upload alone is not sufficient evidence that the tester-facing archive is valid.

## Verification captured in this task

- `git status --short --branch`: clean on `main`, tracking `origin/main`.
- `pnpm --dir apps/desktop typecheck`: passed.
- `cargo test --locked -p railgun-mock-backend saved_fixture_corpus_includes_desktop_qa_sessions`: passed.

## Remaining risk

The highest residual risk is presentation quality across every tool state because the all-tools transcript is intentionally broader than current visual coverage. Accessibility regressions block this beta. Purely cosmetic polish may follow after distribution if it does not reduce comprehension, feedback, or control discoverability.

## Final check

Run the scheduled Thursday 09:00 local-time review, attach the full verification log, name the rollback owner, and record a final go/no-go decision before sending invitations.
"#;

fn all_tools_task_todos(status: &str) -> Vec<Value> {
    [
        ("beta-scope", "Confirm the beta audience and release bar"),
        (
            "beta-context",
            "Review saved preferences and Railgun diagnostics",
        ),
        ("beta-local", "Inspect the repository release contract"),
        (
            "beta-external",
            "Verify current Apple distribution guidance",
        ),
        (
            "beta-review",
            "Collect independent accessibility and safety reviews",
        ),
        (
            "beta-deliver",
            "Write, verify, and schedule the readiness brief",
        ),
    ]
    .into_iter()
    .map(|(id, content)| json!({"id":id,"content":content,"status":status}))
    .collect()
}

pub(super) fn all_tools_completed_todos() -> Vec<Value> {
    all_tools_task_todos("completed")
}

pub(super) fn all_tools_task_messages() -> Vec<Value> {
    let mut messages = vec![json!({
        "role":"user",
        "at":1_785_979_200_000_i64,
        "content":"Prepare a release-readiness brief for Railgun’s private macOS beta. Inspect the repository and configured app state, use my saved preferences, verify current Apple distribution guidance, delegate independent accessibility and release-safety reviews, write the brief to docs/private-beta-readiness.md, and schedule a final Thursday check. Ask me if a release choice would materially change the recommendation."
    })];

    let initial_todos = all_tools_task_todos("pending");
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-001",
        "This request has distinct scope, research, review, verification, delivery, and follow-up phases. I should make that work visible before collecting evidence.",
        "todo",
        json!({"todos":initial_todos.clone(),"merge":false}),
        json!({
            "todos":initial_todos,
            "summary":{"total":6,"pending":6,"in_progress":0,"completed":0,"cancelled":0}
        })
        .to_string(),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-002",
        "The user explicitly asked me to apply saved preferences, so I need the narrow release-related memories before choosing language or gates.",
        "memory_search",
        json!({"query":"Railgun private beta release verification and reporting preferences","limit":10}),
        "- [preference] Keep private-beta reports concise, evidence-first, and explicit about unresolved risk.\n- [project] Use the Electron desktop contracts as the behavioral reference when desktop behavior is ambiguous.\n- [preference] Accessibility regressions block beta distribution.\n- [preference] Keep private-beta reports concise and evidence-first.",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-003",
        "The memory search exposed duplicate reporting preferences but not their identifiers. A bounded diagnostic inspection can retrieve the IDs without reading unrelated application data.",
        "railgun_inspect",
        json!({"area":"memories"}),
        serde_json::to_string_pretty(&json!({"memories":[
            {"id":"memory-21","content":"Keep private-beta reports concise, evidence-first, and explicit about unresolved risk.","category":"preference","createdAt":1_785_700_100_000_i64},
            {"id":"memory-22","content":"Keep private-beta reports concise and evidence-first.","category":"preference","createdAt":1_785_700_000_000_i64},
            {"id":"memory-14","content":"Accessibility regressions block beta distribution.","category":"preference","createdAt":1_784_900_000_000_i64},
            {"id":"memory-8","content":"Use the Electron desktop contracts as the behavioral reference when desktop behavior is ambiguous.","category":"project","createdAt":1_783_000_000_000_i64}
        ]}))
        .expect("mock memory inspection should serialize"),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-004",
        "The two reporting memories express one stable preference. Merging them removes noise while preserving the stricter wording about unresolved risk.",
        "memory_consolidate",
        json!({"operations":[{
            "action":"merge",
            "ids":["memory-21","memory-22"],
            "newContent":"Keep private-beta reports concise, evidence-first, and explicit about unresolved risk.",
            "category":"preference"
        }]}),
        "Merged memories",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-005",
        "A private beta can mean invited external testers or an internal-only ring, and that choice changes signing, distribution, support, and rollback expectations. I need one bounded answer.",
        "clarify",
        json!({
            "question":"Who will receive this private beta?",
            "choices":["Invited testers under NDA","Internal team only","Public waitlist"]
        }),
        json!({
            "question":"Who will receive this private beta?",
            "answer":"Invited testers under NDA"
        })
        .to_string(),
        false,
    );
    messages.push(json!({"role":"assistant","at":1_785_980_407_000_i64,"content":[{"type":"text","text":"I’ll treat this as an external but tightly controlled beta: Developer ID signing, notarization, a named rollback owner, and tester-facing support notes are gates. Public-launch work stays out of scope."}]}));
    messages.push(json!({"role":"user","at":1_785_980_520_000_i64,"content":"Correct. Accessibility problems block the beta; cosmetic polish can follow if it does not hurt comprehension or feedback."}));
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-006",
        "That is a durable release preference stated directly by the user, so saving it will improve future go/no-go work without storing transient task detail.",
        "memory_write",
        json!({
            "content":"For private Railgun betas, accessibility regressions block distribution; cosmetic polish may follow only when comprehension and feedback remain intact.",
            "category":"preference"
        }),
        "Saved.",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-007",
        "Before choosing checks, I should load the repository’s desktop-testing procedure rather than inventing a release verification sequence.",
        "skill_view",
        json!({"name":"desktop-testing"}),
        "# Desktop testing\n\nUse deterministic mock-backend scenarios for renderer work. Run `pnpm --dir apps/desktop test`, `pnpm --dir apps/desktop lint`, `pnpm --dir apps/desktop typecheck`, and `pnpm --dir apps/desktop exec prettier --check .` without launching Electron. For backend contract changes, add `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --locked`. Use `scripts/run-mock.sh` only when the user explicitly asks to launch the GUI.",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-008",
        "Accessibility and release-safety review are independent evidence streams. Delegating both now reduces latency while I inspect the local release contract.",
        "delegate_task",
        json!({"goals":[
            {"goal":"Audit the Railgun private-beta plan for accessibility release blockers. Focus on VoiceOver, keyboard traversal, focus restoration, reduced motion, and approval or clarification interactions. Return findings only; do not edit files."},
            {"goal":"Audit the Railgun release documentation for signing, notarization, artifact validation, rollback, and distribution risks relevant to invited external testers. Return findings only; do not edit files."}
        ]}),
        "Accessibility review\n- Treat missing accessible names, unreachable controls, broken focus restoration, or motion that ignores reduced-motion settings as blockers.\n- Manually cover approval, clarification, failed-tool, long-result, and restored-transcript states with VoiceOver and keyboard-only navigation.\n- Cosmetic spacing differences are non-blocking when state, hierarchy, and feedback remain understandable.\n\nRelease-safety review\n- The documented Electron workflow signs with Developer ID, submits for notarization, staples the ticket, validates Gatekeeper and code signatures, checks the bundled backend, and verifies DMG, ZIP, update-metadata, and appcast layout.\n- Name a rollback owner and retain the prior signed artifact before inviting external testers.\n- Validate migration from the preserved prior release before promoting the beta candidate to stable.",
        false,
    );
    messages.push(json!({"role":"assistant","content":[{"type":"text","text":"The independent reviews agree on the release boundary: accessibility and interaction feedback are gates; minor visual polish is not. The signed Electron artifact and its bundled backend are both in scope."}]}));
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-009",
        "The requested report path may already contain a release-specific draft. I should read it before writing so I do not overwrite prior work blindly.",
        "read_file",
        json!({"path":"/Users/dantea/Projects/railgun/docs/private-beta-readiness.md"}),
        "file does not exist or is inaccessible",
        true,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-010",
        "There is no existing draft, so I need the complete documentation inventory to locate the canonical release guide and avoid guessing at filenames.",
        "list_directory",
        json!({"path":"/Users/dantea/Projects/railgun/docs"}),
        "DATABASE_MIGRATIONS.md\nOPERATIONAL_DIAGNOSTICS.md\nPRODUCT.md\nRELEASING.md\nadr/\nbackend-test-traceability.md\ndesign/\ndesktop-client-lock.md",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-011",
        "The release guide is the local source of truth for supported artifacts and required checks, so I should read it in full before forming a recommendation.",
        "read_file",
        json!({"path":"/Users/dantea/Projects/railgun/docs/RELEASING.md"}),
        include_str!("../../../docs/RELEASING.md"),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-012",
        "The Rust toolchain is part of the signed backend build. Capturing its pinned version makes the local evidence reproducible without reading a large unrelated manifest.",
        "read_file",
        json!({"path":"/Users/dantea/Projects/railgun/rust-toolchain.toml"}),
        include_str!("../../../rust-toolchain.toml"),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-013",
        "The user asked for current Apple guidance, which is time-sensitive. I should locate the primary Apple source before fetching any page content.",
        "web_search",
        json!({
            "query":"site:developer.apple.com notarizing macOS software before distribution Developer ID",
            "max_results":3
        }),
        json!({
            "query":"site:developer.apple.com notarizing macOS software before distribution Developer ID",
            "provider":"duckduckgo",
            "results":[
                {"title":"Notarizing macOS software before distribution","url":"https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution","snippet":"Protect users by submitting Developer ID-signed software to Apple for notarization before distribution."},
                {"title":"Signing Mac software with Developer ID","url":"https://developer.apple.com/developer-id/","snippet":"Distribute Mac apps outside the Mac App Store with Developer ID certificates and Apple notarization."},
                {"title":"Customizing the notarization workflow","url":"https://developer.apple.com/documentation/security/customizing-the-notarization-workflow","snippet":"Automate submission and validation as part of a release workflow."}
            ]
        })
        .to_string(),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-014",
        "Search snippets are not enough for a release gate. I should fetch the primary Apple page and retain the bounded response metadata with the relevant guidance.",
        "web_fetch",
        json!({
            "url":"https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution",
            "max_chars":12000
        }),
        json!({
            "final_url":"https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution",
            "content_type":"text/html; charset=utf-8",
            "content":"Notarizing macOS software before distribution\n\nGive users more confidence in your software by submitting it to the Apple notary service. Before submission, sign the software with a Developer ID certificate and enable the hardened runtime. After Apple returns a successful result, staple the ticket to the distributed software when the format supports stapling. Validate the exact artifact intended for distribution and keep notarization credentials in a secure release environment.",
            "truncated":false
        })
        .to_string(),
        false,
    );
    messages.push(json!({"role":"assistant","at":1_785_981_327_000_i64,"content":[{"type":"text","text":"The external guidance matches Railgun’s release document: sign with Developer ID, use the hardened runtime, notarize, staple, and validate the exact artifact testers receive. I’ll keep that as distribution evidence, not use it to override repository-specific scope."}]}));
    messages.push(json!({"role":"user","at":1_785_981_420_000_i64,"content":"Good. Use the repository as the source of truth, and capture enough focused verification to make the brief credible without launching either app."}));
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-015",
        "A clean worktree is a prerequisite for trustworthy release evidence, and this read-only check does not launch an application or mutate the repository.",
        "run_shell_command",
        json!({"command":"git status --short --branch"}),
        "## main...origin/main",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-016",
        "The desktop typecheck and the focused mock-backend fixture contract directly cover the report’s local claims while respecting the instruction not to launch a GUI.",
        "run_shell_command",
        json!({"command":"pnpm --dir apps/desktop typecheck && cargo test --locked -p railgun-mock-backend saved_fixture_corpus_includes_desktop_qa_sessions"}),
        "> railgun-desktop@0.10.17 typecheck /Users/dantea/Projects/railgun/apps/desktop\n> pnpm run typecheck:node && pnpm run typecheck:web\n\n> railgun-desktop@0.10.17 typecheck:node /Users/dantea/Projects/railgun/apps/desktop\n> tsc --noEmit -p tsconfig.node.json --composite false\n\n> railgun-desktop@0.10.17 typecheck:web /Users/dantea/Projects/railgun/apps/desktop\n> tsc --noEmit -p tsconfig.web.json --composite false\n\n   Compiling railgun-mock-backend v0.9.0 (/Users/dantea/Projects/railgun/crates/railgun-mock-backend)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.41s\n     Running unittests src/main.rs (target/debug/deps/railgun_mock_backend)\n\nrunning 1 test\ntest tests::saved_fixture_corpus_includes_desktop_qa_sessions ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.00s\n\n     Running tests/jsonl_contract.rs (target/debug/deps/jsonl_contract)\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s",
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-017",
        "The evidence is sufficient for a conditional recommendation. I should now write the complete brief to the exact requested path, including scope, gates, evidence, and residual risk.",
        "write_file",
        json!({
            "path":"/Users/dantea/Projects/railgun/docs/private-beta-readiness.md",
            "content":PRIVATE_BETA_REPORT
        }),
        format!(
            "Wrote {} bytes to /Users/dantea/Projects/railgun/docs/private-beta-readiness.md",
            PRIVATE_BETA_REPORT.len()
        ),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-018",
        "A successful write only proves bytes were accepted. Reading the file back verifies the tester-facing artifact and catches path or content mistakes before handoff.",
        "read_file",
        json!({"path":"/Users/dantea/Projects/railgun/docs/private-beta-readiness.md"}),
        PRIVATE_BETA_REPORT,
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-019",
        "Before adding a reminder, I should inspect existing visible schedules to prevent a duplicate release check.",
        "cron",
        json!({"action":"list"}),
        serde_json::to_string_pretty(&json!([
            {
                "id":"mock-cron-morning",
                "schedule":"0 9 * * 1-5",
                "prompt":"Summarize the priorities for today",
                "lastRun":null,
                "requiredOutputs":[]
            },
            {
                "id":"mock-cron-review",
                "schedule":"*/30 8-17 * * MON-FRI",
                "prompt":"Review active work and flag blockers",
                "lastRun":1_752_500_000_000_i64,
                "requiredOutputs":["/tmp/private-contract"]
            }
        ]))
        .expect("mock cron list should serialize"),
        false,
    );
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-020",
        "No existing schedule owns the final beta gate. A Thursday 09:00 local-time job matches the requested review window and points back to the written artifact.",
        "cron",
        json!({
            "action":"add",
            "id":"private-beta-final-check",
            "schedule":"0 9 * * 4",
            "prompt":"Review docs/private-beta-readiness.md, attach the full release verification log, confirm the rollback owner, and record the private-beta go/no-go decision."
        }),
        "Added cron job \"private-beta-final-check\"",
        false,
    );

    let completed_todos = all_tools_completed_todos();
    push_reasoned_tool_use(
        &mut messages,
        "all-tools-021",
        "The brief has been written and read back, verification is recorded, and the final review is scheduled. I should close every task item before the final handoff.",
        "todo",
        json!({"todos":completed_todos.clone(),"merge":false}),
        json!({
            "todos":completed_todos,
            "summary":{"total":6,"pending":0,"in_progress":0,"completed":6,"cancelled":0}
        })
        .to_string(),
        false,
    );
    messages.push(json!({
        "role":"assistant",
        "at":1_785_981_627_000_i64,
        "content":[{"type":"text","text":"The private-beta brief is ready at `docs/private-beta-readiness.md` with a **GO WITH GATES** recommendation. The worktree was clean, desktop typechecking passed, the focused mock-backend contract test passed, Apple’s current distribution guidance was reconciled with Railgun’s release guide, and independent accessibility and release-safety reviews are included. I also merged the duplicate report preference, saved your accessibility release bar, and scheduled `private-beta-final-check` for Thursday at 09:00 local time.\n\nThe remaining gate is the full release checklist plus manual VoiceOver coverage of approval, clarification, failed-tool, long-result, and restored-transcript states. No app was launched."}]
    }));
    messages
}

fn push_reasoned_tool_use(
    messages: &mut Vec<Value>,
    id: &str,
    thinking: &str,
    name: &str,
    arguments: Value,
    result: impl Into<String>,
    is_error: bool,
) {
    messages.push(json!({"role":"assistant","content":[
        {"type":"thinking","thinking":thinking,"thinkingSignature":format!("mock-{id}-signature")},
        {"type":"toolCall","id":id,"name":name,"arguments":arguments}
    ]}));
    messages.push(json!({
        "role":"tool",
        "toolCallId":id,
        "content":result.into(),
        "isError":is_error
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn all_tools_fixture_preserves_complete_calls_results_and_thinking() {
        let messages = all_tools_task_messages();
        let mut calls = HashMap::new();
        let mut results = HashMap::new();

        for message in &messages {
            match message["role"].as_str() {
                Some("assistant") => {
                    let Some(parts) = message["content"].as_array() else {
                        continue;
                    };
                    let thinking = parts.iter().find(|part| part["type"] == "thinking");
                    for call in parts.iter().filter(|part| part["type"] == "toolCall") {
                        let id = call["id"].as_str().expect("tool call id");
                        let name = call["name"].as_str().expect("tool call name");
                        assert!(!id.trim().is_empty());
                        assert!(!name.trim().is_empty());
                        assert!(
                            call["arguments"]
                                .as_object()
                                .is_some_and(|arguments| !arguments.is_empty()),
                            "{name} should retain its complete argument object"
                        );
                        let thinking = thinking.expect("every tool call should include thinking");
                        assert!(
                            thinking["thinking"]
                                .as_str()
                                .is_some_and(|value| !value.trim().is_empty())
                        );
                        assert!(
                            thinking["thinkingSignature"]
                                .as_str()
                                .is_some_and(|value| !value.trim().is_empty())
                        );
                        assert!(calls.insert(id.to_owned(), name.to_owned()).is_none());
                    }
                }
                Some("tool") => {
                    let id = message["toolCallId"].as_str().expect("tool result id");
                    assert!(message.get("content").is_some());
                    assert!(
                        message["content"]
                            .as_str()
                            .is_some_and(|content| !content.is_empty()),
                        "{id} should retain its complete result payload"
                    );
                    assert!(message["isError"].is_boolean());
                    assert!(results.insert(id.to_owned(), message).is_none());
                }
                _ => {}
            }
        }

        assert_eq!(calls.len(), 21);
        assert_eq!(results.len(), calls.len());
        assert!(calls.keys().all(|id| results.contains_key(id)));
        assert_eq!(
            calls.values().cloned().collect::<HashSet<_>>(),
            railgun_backend::tools::TOOL_NAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect()
        );
        assert_eq!(
            results
                .values()
                .filter(|message| message["isError"] == true)
                .count(),
            1
        );
        assert_eq!(results["all-tools-009"]["isError"], true);

        let write = messages
            .iter()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .find(|part| part["id"] == "all-tools-017")
            .expect("report write call");
        assert_eq!(write["arguments"]["content"], PRIVATE_BETA_REPORT);
        assert_eq!(results["all-tools-018"]["content"], PRIVATE_BETA_REPORT);
    }
}
