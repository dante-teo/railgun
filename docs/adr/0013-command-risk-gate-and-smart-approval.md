# 0013. Command risk gate and smart approval

Date: 2026-07-12

## Status

Accepted

## Context

Before Phase 21, every `run_shell_command` call went through the same
interactive y/n approval prompt regardless of how dangerous the command was.
This created two problems in opposite directions:

- **Over-interruption**: safe, read-only commands (`ls`, `echo`, `cat`) blocked
  for human confirmation even though they pose no real risk, slowing down
  agentic workflows where the operator has already decided to trust the session.
- **Under-protection**: there was no unconditional block on clearly catastrophic
  commands. A user operating in a scripted or unattended context who had set an
  approval bypass could still have `rm -rf /` or `mkfs.ext4 /dev/sda` execute.

The replication plan's Phase 21 design called for a risk-classification layer
between the tool handler and the approval UI, with three tiers and a
configurable middle tier.

## Decision

A new pure module, `src/security/commandApproval.ts`, classifies every command
string before any shell is spawned. It is called from `runShell.ts` and returns
one of three `ApprovalRequirement` variants:

`runShell.ts` invokes the user's login shell in non-interactive mode
(`$SHELL -lc`, with a macOS `zsh` fallback). This retains login environment
setup, such as a Homebrew `PATH`, but deliberately excludes interactive aliases
and functions. An approval decision therefore applies to the command string
that executes, rather than to a later alias or function expansion from an
interactive startup file.

**`forbidden`** — returned for any of five hardline regex patterns:

| ID | Matches |
|---|---|
| `root_delete` | `rm -r[f] /` and variants |
| `mkfs` | any `mkfs.*` invocation |
| `shutdown_reboot` | `shutdown` or `reboot` |
| `fork_bomb` | the classic `:(){:|:&};:` pattern |
| `dd_disk` | `dd … of=/dev/<disk>` |

Hardline blocks are unconditional — they apply regardless of `approvalMode`,
session approvals, or any other context. The shell tool returns an error result
immediately with no approval prompt.

**`skip`** — returned when:
- No dangerous pattern matches (the command is safe), or
- The matching pattern's ID is already in the per-session `sessionApprovals`
  set (previously approved this conversation), or
- `approvalMode` is `"off"` (dangerous tier suppressed by operator choice).

The shell tool executes the command directly.

**`needs_approval`** — returned for seven dangerous patterns when neither of
the skip conditions above applies:

| ID | Matches |
|---|---|
| `rm_recursive` | any `rm -r*` |
| `sudo` | any `sudo` invocation |
| `force_push` | `git push … --force` |
| `drop_table` | `DROP TABLE` (case-insensitive) |
| `disk_write` | redirect to `/dev/sd*` |
| `chmod_world` | world-writable `chmod` |
| `curl_pipe_sh` | `curl … \| bash` or `\| sh` |

The shell tool then consults the configured approval tier:

- **`"manual"`** (default): the existing interactive confirmation prompt fires.
  On human approval, the pattern ID is added to `sessionApprovals`.
- **`"smart"`**: `src/security/smartApproval.ts` calls the LLM reviewer
  (`devin.streamChat` with a dedicated security-reviewer system prompt).
  `"approve"` → execute and add to `sessionApprovals`. `"deny"` → return an
  error. `"escalate"` → fall through to the manual prompt.
- **`"off"`**: caught by `skip` above; never reaches `needs_approval`.

The smart reviewer strips shell comments from the command string before sending
it to the model (`stripShellComments` in `commandApproval.ts`), removing the
most accessible prompt-injection vector. The reviewer is fail-safe: any error
or unparseable response returns `"escalate"`.

### Threading

`approvalMode` and `reviewerModel` are read from `~/.railgun/config.json` at
startup and forwarded through `AgentDependencies` → `RunTurnOptions` →
`ToolContext`. The per-session `Set<string>` (`sessionApprovals`) is created
once per REPL session (a `useRef` in `App.tsx`) or per one-shot invocation, so
approvals persist across turns within one conversation but reset between
sessions.

`ToolContext` gains two required fields (`commandApprovalMode`,
`sessionApprovals`) and two optional fields (`devin`, `reviewerModel`) needed
only by the smart path. Making the required fields non-optional forces every
`ToolContext` construction site (tests and entry points alike) to be explicit
about approval policy, catching omissions at compile time.

## Consequences

- Safe commands (`ls`, `echo`, `cat`, `git status`, etc.) no longer interrupt
  the agent for confirmation. Agentic workflows are measurably less chatty.
- Catastrophic commands are blocked at the classifier level regardless of how
  the session was configured. The approval gate is no longer the only line of
  defence.
- A user who sets `"approvalMode": "smart"` and `"reviewerModel": "<id>"` in
  config gets LLM-assisted review for the dangerous tier. The fallback chain
  (smart → escalate → human) means the human is never silently bypassed on
  failure.
- Pattern approvals persist for the duration of one conversation. A user who
  approves `sudo` once will not be re-prompted for `sudo` in that session, but
  a new session starts with a fresh approval set.
- The dangerous-pattern list is a heuristic, not an allowlist. Unknown dangerous
  commands that do not match any pattern will pass as safe. The hardline tier
  covers the most catastrophic known cases unconditionally.
- Interactive shell aliases and functions are not available to agent shell
  commands. Commands that Railgun must invoke should be installed executables
  or be configured through the login-shell environment instead.
- `ToolContext` now requires `commandApprovalMode` and `sessionApprovals`. All
  test contexts must supply them; the compiler enforces this. Callers that omit
  `sessionApprovals` via `RunTurnOptions` receive an ephemeral `Set` scoped to
  that single turn — session-persistence requires the caller to retain and
  supply the same `Set` across turns.
