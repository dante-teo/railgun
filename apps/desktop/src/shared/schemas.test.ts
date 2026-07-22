import { describe, expect, it } from "vitest";
import {
  AppCommandSchema,
  BackendSnapshotSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  MockScenarioSchema,
  TransportLogEntrySchema,
  ExternalUrlSchema,
  DesktopAgentEventSchema,
  DESKTOP_ACTIVITY_LIMITS,
  ChatControlsSnapshotSchema,
  AgentControlUpdateSchema,
  ControlMutationResultSchema,
  SessionSnapshotSchema,
  SessionSummaryListSchema,
  ArchivedSessionSummaryListSchema,
  DESKTOP_SESSION_LIMITS,
  DESKTOP_FILE_LIMITS,
  DirectoryListingSchema,
  FilePathSegmentsSchema,
  FilePreviewSchema,
  CronJobInputSchema,
  CronJobListSchema,
  DESKTOP_CRON_LIMITS,
  DESKTOP_KNOWLEDGE_LIMITS,
  SkillSummaryListSchema,
  SkillDetailSchema,
  McpServerListSchema,
  McpServerUpsertSchema,
} from "./schemas";

const validSnapshot = {
  mode: "mock",
  phase: "ready",
  scenarioId: "ready-idle",
  diagnostics: [],
  transportLog: [{ direction: "system", text: "ready" }],
} as const;

describe("desktop boundary schemas", () => {
  it("accepts valid snapshots, entries, scenarios, and ids", () => {
    expect(AppCommandSchema.parse("command-palette")).toBe("command-palette");
    expect(BackendSnapshotSchema.parse(validSnapshot)).toEqual(validSnapshot);
    expect(TransportLogEntrySchema.parse(validSnapshot.transportLog[0])).toEqual(validSnapshot.transportLog[0]);
    expect(MockScenarioIdSchema.parse("ready-idle")).toBe("ready-idle");
    expect(BackendSnapshotSchema.parse({ ...validSnapshot, phase: "authentication-required" }).phase)
      .toBe("authentication-required");
    expect(MockScenarioSchema.parse({ id: "ready-idle", label: "Ready", description: "Ready now" })).toBeTruthy();
    expect(MockScenarioListSchema.parse([{ id: "ready-idle", label: "Ready", description: "Ready now" }])).toHaveLength(1);
    expect(ExternalUrlSchema.parse("https://example.com/docs")).toBe("https://example.com/docs");
  });

  it("rejects unknown fields at every object boundary", () => {
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, electron: {} })).toThrow();
    expect(() => TransportLogEntrySchema.parse({ ...validSnapshot.transportLog[0], extra: true })).toThrow();
    expect(() => MockScenarioSchema.parse({ id: "ready-idle", label: "Ready", description: "Ready", behavior: "crash" })).toThrow();
  });

  it("rejects wrong discriminants, malformed arrays, and invalid ids", () => {
    expect(() => AppCommandSchema.parse("open-terminal")).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, phase: "loading" })).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, diagnostics: "none" })).toThrow();
    expect(() => BackendSnapshotSchema.parse({ ...validSnapshot, transportLog: [null] })).toThrow();
    expect(() => TransportLogEntrySchema.parse({ direction: "network", text: "bad" })).toThrow();
    expect(() => MockScenarioIdSchema.parse("../../escape")).toThrow();
    expect(() => ExternalUrlSchema.parse("javascript:alert(1)")).toThrow();
    expect(() => ExternalUrlSchema.parse("https://user:pass@example.com")).toThrow();
    expect(() => MockScenarioListSchema.parse({ id: "ready-idle" })).toThrow();
  });

  it("validates every agent activity variant strictly", () => {
    const events = [
      { type: "tool-start", id: "call-1", name: "read_file", input: "{}" },
      { type: "tool-end", id: "call-1", name: "read_file", failed: false, output: "ok", todos: [{ id: "a", content: "Ship", status: "completed" }] },
      { type: "moa-reference-start", index: 0, count: 2, model: "ref" },
      { type: "moa-reference-end", index: 0, model: "ref", preview: "idea" },
      { type: "moa-aggregating", model: "agg", refCount: 2 },
      { type: "advisor-note", severity: "concern", text: "Check this" },
      { type: "subagent-start", index: 0, count: 1, goal: "Inspect" },
      { type: "subagent-end", index: 0, goal: "Inspect", result: "Done" },
    ] as const;
    expect(events.map(event => DesktopAgentEventSchema.parse(event))).toEqual(events);
    expect(() => DesktopAgentEventSchema.parse({ ...events[5], severity: "critical" })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[0], args: { secret: true } })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[0], input: "x".repeat(DESKTOP_ACTIVITY_LIMITS.detail + 1) })).toThrow();
    expect(() => DesktopAgentEventSchema.parse({ ...events[5], text: "x".repeat(DESKTOP_ACTIVITY_LIMITS.content + 1) })).toThrow();
  });

  it("validates bounded chat controls without accepting raw configuration", () => {
    const controls = {
      models: [{ id: "model-a", name: "Model A", inputs: ["text", "image"], supportsTools: true, reasoning: true, contextWindow: 200_000, maxOutputTokens: 16_000 }],
      activeModelId: "model-a",
      defaultModelId: "model-a",
      messageCount: 2,
      moaPresets: [{ name: "review", referenceModels: ["ref-a"], aggregatorModel: "model-a", referenceMaxTokens: 4_000 }],
      activeMoaPreset: "review",
      advisor: { enabled: true, modelId: "ref-a" },
      contextWindow: 200_000,
    } as const;
    expect(ChatControlsSnapshotSchema.parse(controls)).toEqual(controls);
    expect(AgentControlUpdateSchema.parse({ moaPreset: null })).toEqual({ moaPreset: null });
    expect(AgentControlUpdateSchema.parse({ advisor: { enabled: true, modelId: "ref-a" } })).toBeTruthy();
    expect(ControlMutationResultSchema.parse({ controls, persistence: "partial", warning: "Task changed; default was not saved." })).toBeTruthy();
    expect(() => ChatControlsSnapshotSchema.parse({ ...controls, config: { secret: "no" } })).toThrow();
    expect(() => ChatControlsSnapshotSchema.parse({ ...controls, models: Array.from({ length: 257 }, (_, index) => ({ ...controls.models[0], id: `m-${index}` })) })).toThrow();
    expect(() => AgentControlUpdateSchema.parse({})).toThrow();
    expect(() => AgentControlUpdateSchema.parse({ advisor: { enabled: true, modelId: null } })).toThrow();
  });

  it("accepts only bounded sanitized desktop session payloads", () => {
    const summary = { id: "session-1", model: "model-a", startedAtLocal: "today", messageCount: 2, firstUserPreview: "Hello" };
    expect(SessionSummaryListSchema.parse([summary])).toEqual([summary]);
    const scheduled = {
      ...summary,
      firstUserPreview: "Daily summary",
      delivery: { kind: "scheduled", jobId: "job-1", title: "Daily summary", status: "incomplete", unread: true },
    } as const;
    expect(SessionSummaryListSchema.parse([scheduled])).toEqual([scheduled]);
    const archived = { ...summary, archivedAt: "2026-07-15T08:00:00.000Z" };
    expect(ArchivedSessionSummaryListSchema.parse([archived])).toEqual([archived]);
    expect(() => ArchivedSessionSummaryListSchema.parse([{ ...archived, token: "private" }])).toThrow();
    const session = { id: "session-1", startedAt: "2026-07-14T08:00:00.000Z", model: "model-a", messageCount: 2, running: false, checkpoint: { state: "saved" }, transcript: [{ role: "user", text: "Hello", messageId: 42 }], todos: [] };
    expect(SessionSnapshotSchema.parse(session)).toEqual(session);
    expect(SessionSnapshotSchema.parse({ ...session, delivery: { ...scheduled.delivery, unread: false } }))
      .toMatchObject({ delivery: { kind: "scheduled", status: "incomplete", unread: false } });
    expect(() => SessionSnapshotSchema.parse({ ...session, rawMessages: [{ role: "tool", content: "secret" }] })).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, transcript: [{ role: "tool", text: "secret" }] })).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, transcript: [{ role: "user", text: "Hello", messageId: 0 }] })).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, transcript: [{ role: "user", text: "Hello", messageId: 42, branchable: true }] })).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, transcript: [{ role: "assistant", text: "Hello", branchable: true }] })).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, transcript: [{ role: "user", text: "Hello", messageId: 42, provider: { secret: true } }] })).toThrow();
    expect(() => SessionSummaryListSchema.parse(Array.from({ length: DESKTOP_SESSION_LIMITS.sessions + 1 }, () => summary))).toThrow();
    expect(() => SessionSnapshotSchema.parse({ ...session, checkpoint: { state: "error", detail: "x".repeat(DESKTOP_SESSION_LIMITS.checkpointError + 1) } })).toThrow();
  });

  it("accepts only segmented paths and bounded file-browser payloads", () => {
    expect(FilePathSegmentsSchema.parse([])).toEqual([]);
    expect(FilePathSegmentsSchema.parse([".config", "back\\slash"])).toEqual([".config", "back\\slash"]);
    for (const invalid of [[".."], ["."], ["/tmp"], ["a/b"], [""]]) {
      expect(() => FilePathSegmentsSchema.parse(invalid)).toThrow();
    }
    const listing = { entries: [{ name: ".hidden", kind: "file", symlink: false }] } as const;
    expect(DirectoryListingSchema.parse(listing)).toEqual(listing);
    expect(() => DirectoryListingSchema.parse({ entries: [{ ...listing.entries[0], path: "/secret" }] })).toThrow();
    expect(() => DirectoryListingSchema.parse({ entries: Array.from({ length: DESKTOP_FILE_LIMITS.directoryEntries + 1 }, (_, index) => ({ name: `f${index}`, kind: "file", symlink: false })) })).toThrow();
    expect(FilePreviewSchema.parse({ kind: "text", text: "hello" })).toEqual({ kind: "text", text: "hello" });
    expect(FilePreviewSchema.parse({ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 2, height: 3 })).toBeTruthy();
    expect(() => FilePreviewSchema.parse({ kind: "image", dataUrl: "file:///secret", width: 2, height: 3 })).toThrow();
    expect(() => FilePreviewSchema.parse({ kind: "image", dataUrl: "data:image/png;base64,x", width: 10_000, height: 10_000 })).toThrow();
  });

  it("accepts only bounded strict cron jobs and mutation inputs", () => {
    const job = { id: "job-1", schedule: "0 9 * * 1-5", summary: "At 09:00, Monday through Friday", prompt: "Plan the day" };
    expect(CronJobListSchema.parse([job])).toEqual([job]);
    expect(CronJobInputSchema.parse({ schedule: " 0  9 * * 1-5 ", prompt: " Plan the day " })).toEqual({ schedule: "0 9 * * 1-5", prompt: "Plan the day" });
    expect(() => CronJobListSchema.parse([{ ...job, lastRun: 123 }])).toThrow();
    expect(() => CronJobInputSchema.parse({ schedule: "0 9 * * 1-5", prompt: "Run", id: "managed" })).toThrow();
    expect(() => CronJobInputSchema.parse({ schedule: "0 0 9 * * *", prompt: "Run" })).toThrow();
    expect(() => CronJobInputSchema.parse({ schedule: "0 9 * * *", prompt: "x".repeat(DESKTOP_CRON_LIMITS.prompt + 1) })).toThrow();
    expect(() => CronJobListSchema.parse([{ ...job, summary: "x".repeat(DESKTOP_CRON_LIMITS.summary + 1) }])).toThrow();
    const worstCasePage = JSON.stringify({ type: "response", command: "cron_list", success: true, data: { jobs: [{ ...job, prompt: "\0".repeat(DESKTOP_CRON_LIMITS.prompt) }] } });
    expect(worstCasePage.length).toBeLessThan(64 * 1_024);
  });

  it("bounds skills and rejects path or secret-bearing management responses", () => {
    const skill = { name: "desktop-testing", description: "Desktop tests", disableModelInvocation: false } as const;
    expect(SkillSummaryListSchema.parse([skill])).toEqual([skill]);
    expect(SkillDetailSchema.parse({ ...skill, body: "# Safe" })).toBeTruthy();
    expect(() => SkillSummaryListSchema.parse(Array.from({ length: DESKTOP_KNOWLEDGE_LIMITS.skills + 1 }, () => skill))).toThrow();
    expect(() => SkillDetailSchema.parse({ ...skill, body: "ok", path: "/private/skill.md" })).toThrow();
    const server = { name: "docs", command: "server", args: ["--stdio"], env: [{ name: "TOKEN", present: true }] } as const;
    expect(McpServerListSchema.parse([server])).toEqual([server]);
    expect(() => McpServerListSchema.parse([{ ...server, env: [{ name: "TOKEN", present: true, value: "secret" }] }])).toThrow();
    expect(() => McpServerListSchema.parse([{ ...server, path: "/private/server" }])).toThrow();
  });

  it("validates strict MCP drafts and unique environment keys", () => {
    expect(McpServerUpsertSchema.parse({ name: "docs", command: "node", args: ["server.js"], env: [{ name: "TOKEN", value: null }] })).toBeTruthy();
    expect(() => McpServerUpsertSchema.parse({ name: "", command: "node", args: [], env: [] })).toThrow();
    expect(() => McpServerUpsertSchema.parse({ name: "docs", command: "", args: [], env: [] })).toThrow();
    expect(() => McpServerUpsertSchema.parse({ name: "docs", command: "node", args: [], env: [{ name: "TOKEN", value: "a" }, { name: "TOKEN", value: "b" }] })).toThrow(/unique/u);
    expect(() => McpServerUpsertSchema.parse({ name: "docs", command: "node", args: [], env: [], rawConfig: {} })).toThrow();
    expect(() => McpServerUpsertSchema.parse({ name: "docs", command: "node", args: Array.from({ length: 64 }, () => "x".repeat(8_000)), env: [] })).toThrow(/too large/u);
  });
});
