# 0001. Use a single AI provider (Devin via widevin), not a multi-provider abstraction

Date: 2026-07-07

## Status

Accepted

## Context

Hermes Agent (the system this project replicates) supports 18+ AI providers through a generic
provider-resolver abstraction. Building and maintaining that abstraction is a large amount of
work unrelated to the actual agent logic (chat loop, tools, memory, GUIs) this project exists to
practice.

## Decision

Railgun talks to exactly one model backend, Devin, through the `widevin` npm package
(https://github.com/dante-teo/widevin). `widevin`'s own exported types (`DevinMessage`,
`DevinTool`, `DevinStreamEvent`, `DevinModel`, `DevinProvider`) are used directly as Railgun's
internal data model — no separate generic `ChatMessage`/provider-agnostic shape is introduced.

## Consequences

- No multi-provider phase or abstraction layer is ever added; a second provider would require
  revisiting this decision, not just adding a branch.
- Railgun inherits `widevin`'s compliance constraint: programmatic Devin access is only
  permitted when the operator's organization and Devin's terms allow it. This is an operational
  responsibility, not something the code enforces.
- Token-store primitives, OAuth mechanics, model discovery, and stream-event
  parsing are delegated to `widevin`. Railgun owns application-level selection
  between environment and file stores, source-aware 401 invalidation, and CLI
  login/logout orchestration; see ADR 0008. Railgun does not reimplement the
  underlying Devin protocol.
