import { createInterface } from "node:readline";
import { createRpcTranscriptPage } from "../../../../src/rpc/sessionTranscript.js";
import { getMockScenario } from "./scenarios";
import { parseCronSchedule } from "../shared/cron";

const scenario = getMockScenario(process.argv[2] ?? "ready-idle");
let messageCount = 0;
let activeModel = "mock-model";
interface MockSession {
  readonly id: string;
  readonly startedAt: string;
  readonly startedAtLocal: string;
  model: string;
  messages: unknown[];
  todos: unknown[];
  persistence: "unsaved" | "saved" | "error";
  checkpointError?: string;
  messageIds?: number[];
}
const savedSessions: MockSession[] = [
  {
    id: "mock-session-rich-history", startedAt: "2026-07-14T08:45:00.000Z", startedAtLocal: "7/14/2026, 4:45:00 PM", model: "mock-model", persistence: "saved",
    messages: [
      { role: "user", content: "Build a rich session history for desktop QA" },
      { role: "assistant", content: [{ type: "thinking", thinking: "This private reasoning must never render", thinkingSignature: "mock-private-signature" }, { type: "text", text: "# Desktop QA plan\n\nI’ll exercise **session restoration**, Markdown, todos, and scrolling.\n\n- Resume the saved session\n- Verify the toolbar title\n- Confirm private tool data is absent" }] },
      { role: "user", content: "Include a code example and a status table" },
      { role: "assistant", content: [{ type: "toolCall", id: "rich-tool-1", name: "read_file", arguments: { path: "/private/mock/path", token: "must-not-cross-boundary" } }] },
      { role: "tool", toolCallId: "rich-tool-1", content: "sensitive raw provider payload", isError: false },
      { role: "assistant", content: [{ type: "text", text: "Here is the renderer check:\n\n```ts\nconst restored = transcript.every(message => message.text.length > 0);\n```\n\n| Area | Expected |\n| --- | --- |\n| Transcript | Rich text restored |\n| Tools | Hidden |\n| Todos | Visible |" }] },
      { role: "user", content: "What edge cases should I click through?" },
      { role: "assistant", content: [{ type: "text", text: "Try filtering by `rich`, `mock-model`, and the full session ID. Then switch sessions, start a new chat, and return here. Also resize the sidebar and inspector to stress the layout." }] },
      { role: "user", content: "Add enough content to verify transcript scrolling." },
      { role: "assistant", content: [{ type: "text", text: "Scroll verification paragraph one: restored messages retain their original order.\n\nParagraph two: the transcript should begin near the latest message while remaining keyboard accessible.\n\nParagraph three: checkpoint status should read Saved immediately after resume.\n\nParagraph four: no thinking signatures, tool arguments, or tool-result payloads should appear anywhere in the renderer." }] },
    ],
    todos: [
      { id: "rich-done", content: "Restore textual conversation history", status: "completed" },
      { id: "rich-active", content: "Inspect the rich transcript visually", status: "in_progress" },
      { id: "rich-next", content: "Test filtering and session switching", status: "pending" },
      { id: "rich-cancelled", content: "Render raw tool payloads", status: "cancelled" },
    ],
  },
  {
    id: "mock-session-recent", startedAt: "2026-07-14T08:30:00.000Z", startedAtLocal: "7/14/2026, 4:30:00 PM", model: "mock-model", persistence: "saved",
    messages: [
      { role: "user", content: "Polish the desktop session navigator" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private mock thought", thinkingSignature: "secret" }, { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "secret" } }, { type: "text", text: "The navigator is ready to review." }] },
      { role: "tool", toolCallId: "call-1", content: "raw tool output must stay private", isError: false },
    ],
    todos: [{ id: "mock-todo", content: "Verify restored session UI", status: "in_progress" }],
  },
  {
    id: "mock-session-older", startedAt: "2026-07-13T05:15:00.000Z", startedAtLocal: "7/13/2026, 1:15:00 PM", model: "mock-reference", persistence: "saved",
    messages: [{ role: "user", content: "Audit keyboard navigation" }, { role: "assistant", content: [{ type: "text", text: "Keyboard navigation is covered." }] }], todos: [],
  },
];
let nextSession = 1;
let nextMessageId = 1_000;
const ensureMessageIds = (session: MockSession): number[] => {
  if (session.messageIds === undefined) session.messageIds = session.messages.map(() => nextMessageId++);
  return session.messageIds;
};
savedSessions.forEach(ensureMessageIds);
let activeSession: MockSession = {
  id: "mock-session", startedAt: "2026-07-14T09:00:00.000Z", startedAtLocal: "7/14/2026, 5:00:00 PM",
  model: "mock-model", messages: [], todos: [], persistence: "unsaved",
};
const syncSessionState = (): void => { messageCount = activeSession.messages.length; activeModel = activeSession.model; };
const firstUserPreview = (session: MockSession): string => {
  const message = session.messages.find(value => typeof value === "object" && value !== null && (value as Record<string, unknown>).role === "user") as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content.slice(0, 500) : "";
};
const checkpointMockTurn = (assistantText: string): void => {
  const messageIds = ensureMessageIds(activeSession);
  activeSession.messages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] });
  messageIds.push(nextMessageId++);
  activeSession.persistence = scenario.behavior === "store-error" ? "error" : "saved";
  if (activeSession.persistence === "error") activeSession.checkpointError = "mock checkpoint write failed";
  else delete activeSession.checkpointError;
  messageCount = activeSession.messages.length;
  if (!savedSessions.some(session => session.id === activeSession.id)) savedSessions.unshift(activeSession);
};
let config: Record<string, unknown> = {
  model: "mock-model",
  moaPresets: {
    review: {
      referenceModels: [{ model: "mock-reference" }],
      aggregator: { model: "mock-model" },
      referenceMaxTokens: 4_000,
    },
  },
  advisor: { enabled: false, model: "mock-reference" },
};
interface MockCronJob {
  readonly id: string;
  schedule: string;
  prompt: string;
  readonly lastRun: number | null;
  readonly requiredOutputs: readonly string[];
}
let cronJobs: MockCronJob[] = [
  { id: "mock-cron-morning", schedule: "0 9 * * 1-5", prompt: "Summarize the priorities for today", lastRun: null, requiredOutputs: [] },
  { id: "mock-cron-review", schedule: "*/30 8-17 * * MON-FRI", prompt: "Review active work and flag blockers", lastRun: 1_752_500_000_000, requiredOutputs: ["/tmp/private-contract"] },
];
let nextCronJob = 1;

const mockSkills = [
  { name: "desktop-testing", description: "Test desktop flows with deterministic fixtures.", disableModelInvocation: false, body: "# Desktop testing\n\nUse deterministic scenarios and assert renderer-safe boundaries." },
  { name: "release-checklist", description: "Review release readiness without automatic model invocation.", disableModelInvocation: true, body: "# Release checklist\n\nVerify tests, packaging, and release notes." },
];
let mockMcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
  docs: { command: "/opt/railgun/bin/docs-server", args: ["--stdio", "--format", "markdown"], env: { DOCS_TOKEN: "mock-stored-secret", REGION: "us-east-1" } },
};
const safeMockMcpServers = (): readonly Record<string, unknown>[] => Object.entries(mockMcpServers).map(([name, server]) => ({
  name,
  command: server.command,
  args: server.args,
  env: Object.keys(server.env).sort().map(key => ({ name: key, present: true })),
}));
let writingFrame = false;
interface QueuedFrame {
  readonly line: string;
  readonly delayMs: number;
  readonly prompt?: ActivePrompt;
}

const frameQueue: QueuedFrame[] = [];

const flushFrameQueue = (): void => {
  if (writingFrame) return;
  const frame = frameQueue.shift();
  if (frame === undefined) return;
  writingFrame = true;
  const splitAt = Math.max(1, Math.floor(frame.line.length / 2));
  process.stdout.write(frame.line.slice(0, splitAt));
  setTimeout(() => {
    process.stdout.write(frame.line.slice(splitAt));
    writingFrame = false;
    setTimeout(flushFrameQueue, frame.delayMs);
  }, frame.delayMs);
};

const writeFragmented = (value: unknown, delayMs = 8, prompt?: ActivePrompt): void => {
  frameQueue.push({ line: `${JSON.stringify(value)}\n`, delayMs, ...(prompt === undefined ? {} : { prompt }) });
  flushFrameQueue();
};

interface ActivePrompt {
  readonly id: unknown;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  steering: string[];
  followUp: string[];
}

let activePrompt: ActivePrompt | undefined;
let activeInteraction: { readonly kind: "approval" | "clarification"; readonly requestId: string; readonly promptId: unknown } | undefined;

const schedulePromptOutput = (prompt: ActivePrompt, value: unknown, delayMs: number): void => {
  const timer = setTimeout(() => {
    prompt.timers.delete(timer);
    if (activePrompt !== prompt) return;
    writeFragmented(value, 8, prompt);
  }, delayMs);
  prompt.timers.add(timer);
};

const respond = (
  command: string,
  id: unknown,
  result: { readonly data?: unknown; readonly error?: string } = {},
): void => {
  const base = {
    ...(typeof id === "string" ? { id } : {}),
    type: "response",
    command,
  };
  writeFragmented(
    result.error === undefined
      ? { ...base, success: true, ...(result.data === undefined ? {} : { data: result.data }) }
      : { ...base, success: false, error: result.error },
  );
};

if (scenario.behavior === "authentication-required") {
  writeFragmented({
    type: "startup_status",
    status: "authentication_required",
    credential_source: "file",
  });
  setTimeout(() => process.exit(1), 30);
} else if (scenario.behavior === "crash-before-ready") {
  process.stderr.write("mock backend crashed before readiness\n");
  setTimeout(() => process.exit(17), 20);
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let command: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      command = parsed as Record<string, unknown>;
    } catch {
      respond("unknown", undefined, { error: "parse_error: invalid JSON" });
      return;
    }

    const type = typeof command.type === "string" ? command.type : "unknown";
    if (scenario.behavior === "malformed-output") {
      process.stdout.write("{malformed-json\n");
      return;
    }
    if (type === "initialize") {
      if (scenario.behavior === "handshake-failure") {
        respond(type, command.id, { error: "mock protocol mismatch" });
        return;
      }
      const sendHandshake = (): void => respond(type, command.id, {
        data: {
          version: 1,
          capabilities: ["sessions", "interaction.approval", "interaction.clarification", "config", "mcp", "cron", "memory", "notes", "skills"],
        },
      });
      setTimeout(sendHandshake, scenario.behavior === "delayed-startup" ? 600 : 5);
      return;
    }
    if (scenario.behavior === "reject-commands") {
      respond(type, command.id, { error: `mock rejected ${type}` });
      return;
    }
    if (type === "get_state") {
      const sendState = (): void => {
        respond(type, command.id, {
          data: {
            running: activePrompt !== undefined,
            model: activeModel,
            messageCount,
            todos: activeSession.todos,
            protocolVersion: 1,
            sessionId: activeSession.id,
            startedAt: activeSession.startedAt,
            persistence: activeSession.persistence,
            ...(activeSession.checkpointError === undefined ? {} : { checkpointError: activeSession.checkpointError }),
          },
        });
        if (scenario.behavior === "disconnect-after-ready") {
          setTimeout(() => process.exit(23), 80);
        }
      };
      setTimeout(sendState, scenario.behavior === "delayed-startup" ? 600 : 15);
      return;
    }
    if (type === "get_messages") {
      respond(type, command.id, { data: { messages: activeSession.messages } });
      return;
    }
    if (type === "session_list") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: session_list" }); return; }
      const sessions = scenario.behavior === "empty-stores" ? [] : savedSessions.map(session => ({
        id: session.id, model: session.model, startedAtLocal: session.startedAtLocal,
        messageCount: session.messages.length, firstUserPreview: firstUserPreview(session),
      }));
      setTimeout(() => respond(type, command.id, { data: { sessions } }), 25);
      return;
    }
    if (type === "session_new") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot create a new session while agent is running" }); return; }
      const id = `mock-new-${String(nextSession++)}`;
      activeSession = { id, startedAt: new Date(Date.UTC(2026, 6, 14, 10, nextSession)).toISOString(), startedAtLocal: "7/14/2026, 6:00:00 PM", model: "mock-model", messages: [], todos: [], persistence: "unsaved" };
      syncSessionState();
      setTimeout(() => respond(type, command.id, { data: { sessionId: id } }), 40);
      return;
    }
    if (type === "session_load") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot load a session while agent is running" }); return; }
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: session_load" }); return; }
      if (command.includeMessages !== undefined && typeof command.includeMessages !== "boolean") {
        respond(type, command.id, { error: "invalid command: includeMessages must be a boolean" });
        return;
      }
      const selected = savedSessions.find(session => session.id === command.sessionId);
      if (selected === undefined) { respond(type, command.id, { error: `session not found: ${String(command.sessionId)}` }); return; }
      activeSession = { ...selected, messages: [...selected.messages], messageIds: [...ensureMessageIds(selected)], todos: [...selected.todos] };
      syncSessionState();
      setTimeout(() => respond(type, command.id, {
        data: {
          sessionId: selected.id,
          ...(command.includeMessages === false ? {} : { messages: activeSession.messages }),
        },
      }), 60);
      return;
    }
    if (type === "session_transcript") {
      if (command.sessionId !== activeSession.id) { respond(type, command.id, { error: "requested transcript does not match the active session" }); return; }
      if (command.cursor !== undefined && (!Number.isInteger(command.cursor) || (command.cursor as number) < 0)) {
        respond(type, command.id, { error: "invalid command: cursor must be a non-negative integer" });
        return;
      }
      if (command.limit !== undefined && (!Number.isInteger(command.limit) || (command.limit as number) < 1 || (command.limit as number) > 100)) {
        respond(type, command.id, { error: "invalid command: limit must be an integer between 1 and 100" });
        return;
      }
      const cursor = command.cursor as number | undefined;
      const limit = command.limit as number | undefined;
      respond(type, command.id, { data: createRpcTranscriptPage(activeSession.id, activeSession.messages, cursor, limit, ensureMessageIds(activeSession)) });
      return;
    }
    if (type === "session_branch") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot branch a session while agent is running" }); return; }
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: session_branch" }); return; }
      if (!Number.isInteger(command.messageId) || (command.messageId as number) < 1) { respond(type, command.id, { error: "invalid command: messageId must be a positive integer" }); return; }
      if (typeof command.summarize !== "boolean" || (command.includeMessages !== undefined && typeof command.includeMessages !== "boolean")) { respond(type, command.id, { error: "invalid branch options" }); return; }
      if (activeSession.persistence !== "saved") { respond(type, command.id, { error: "active session must be saved before branching" }); return; }
      const index = ensureMessageIds(activeSession).indexOf(command.messageId as number);
      if (index < 0) { respond(type, command.id, { error: `message ${String(command.messageId)} is not on the active branch` }); return; }
      const branchableIds = new Set(createRpcTranscriptPage(activeSession.id, activeSession.messages, 0, 100, ensureMessageIds(activeSession)).messages.filter(message => message.branchable).map(message => message.messageId));
      if (!branchableIds.has(command.messageId as number)) { respond(type, command.id, { error: `message ${String(command.messageId)} is not a complete turn boundary` }); return; }
      activeSession.messages = activeSession.messages.slice(0, index + 1);
      activeSession.messageIds = ensureMessageIds(activeSession).slice(0, index + 1);
      const savedIndex = savedSessions.findIndex(session => session.id === activeSession.id);
      if (savedIndex >= 0) savedSessions[savedIndex] = activeSession;
      syncSessionState();
      setTimeout(() => respond(type, command.id, { data: {
        ...(command.includeMessages === false ? {} : { messages: activeSession.messages }),
        recentMessages: activeSession.messages.slice(-10).map((message, offset) => ({ id: activeSession.messageIds![Math.max(0, activeSession.messages.length - 10) + offset], role: (message as Record<string, unknown>).role, preview: "mock message" })),
      } }), 80);
      return;
    }
    if (type === "session_fork") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot fork a session while agent is running" }); return; }
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: session_fork" }); return; }
      if (command.includeMessages !== undefined && typeof command.includeMessages !== "boolean") { respond(type, command.id, { error: "invalid command: includeMessages must be a boolean" }); return; }
      const source = savedSessions.find(session => session.id === (command.sessionId ?? activeSession.id));
      if (source === undefined) { respond(type, command.id, { error: `session not found: ${String(command.sessionId)}` }); return; }
      const forkId = `mock-fork-${String(nextSession++)}`;
      activeSession = {
        ...source,
        id: forkId,
        startedAt: new Date(Date.UTC(2026, 6, 14, 11, nextSession)).toISOString(),
        startedAtLocal: "7/14/2026, 7:00:00 PM",
        messages: [...source.messages],
        messageIds: source.messages.map(() => nextMessageId++),
        todos: [...source.todos],
      };
      savedSessions.unshift(activeSession);
      syncSessionState();
      setTimeout(() => respond(type, command.id, { data: { sessionId: forkId, ...(command.includeMessages === false ? {} : { messages: activeSession.messages }) } }), 80);
      return;
    }
    if (type === "get_available_models") {
      respond(type, command.id, { data: { models: scenario.behavior === "empty-model-catalog" ? [] : [
        { id: "mock-model", name: "Mock Model", provider: "devin", baseUrl: "https://mock.invalid", input: ["text", "image"], supportsTools: true, reasoning: true, contextWindow: 200_000, maxTokens: 16_000 },
        { id: "mock-reference", name: "Mock Reference", provider: "devin", baseUrl: "https://mock.invalid", input: ["text"], supportsTools: true, reasoning: false, contextWindow: 100_000, maxTokens: 8_000 },
      ] } });
      return;
    }
    if (type === "config_get") {
      respond(type, command.id, { data: { config } });
      return;
    }
    if (type === "set_model") {
      if (activePrompt !== undefined) respond(type, command.id, { error: "cannot change model while agent is running" });
      else if (command.modelId !== "mock-model" && command.modelId !== "mock-reference") respond(type, command.id, { error: "unknown model" });
      else if (command.modelId === activeSession.model) respond(type, command.id);
      else {
        const model = command.modelId;
        activeSession = activeSession.persistence === "saved"
          ? {
            ...activeSession,
            id: `mock-model-fork-${String(nextSession++)}`,
            startedAt: new Date().toISOString(),
            startedAtLocal: new Date().toLocaleString(),
            model,
            messages: [...activeSession.messages],
            todos: [...activeSession.todos],
            persistence: "unsaved",
          }
          : { ...activeSession, model };
        syncSessionState();
        respond(type, command.id);
      }
      return;
    }
    if (type === "config_update") {
      if (typeof command.patch !== "object" || command.patch === null || Array.isArray(command.patch)) {
        respond(type, command.id, { error: "invalid config patch" });
        return;
      }
      const { activeMoaPreset, ...patch } = command.patch as Record<string, unknown>;
      config = { ...config, ...patch };
      if (activeMoaPreset === null) delete config.activeMoaPreset;
      else if (activeMoaPreset !== undefined) config.activeMoaPreset = activeMoaPreset;
      respond(type, command.id, { data: { config } });
      return;
    }
    if (type === "skills_list") {
      if (scenario.behavior === "store-error") respond(type, command.id, { error: "mock store error: skills_list" });
      else respond(type, command.id, { data: { skills: scenario.behavior === "empty-stores" ? [] : mockSkills.map(({ body: _body, ...skill }) => skill) } });
      return;
    }
    if (type === "skill_get") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: skill_get" }); return; }
      const skill = scenario.behavior === "empty-stores" ? undefined : mockSkills.find(item => item.name === command.name);
      if (skill === undefined) respond(type, command.id, { error: `skill not found: ${String(command.name)}` });
      else respond(type, command.id, { data: { skill } });
      return;
    }
    if (type === "mcp_list") {
      if (scenario.behavior === "store-error") respond(type, command.id, { error: "mock store error: mcp_list" });
      else respond(type, command.id, { data: { servers: scenario.behavior === "empty-stores" ? [] : safeMockMcpServers() } });
      return;
    }
    if (type === "mcp_upsert") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: mcp_upsert" }); return; }
      if (typeof command.name !== "string" || typeof command.command !== "string") { respond(type, command.id, { error: "invalid MCP server" }); return; }
      const previous = mockMcpServers[command.name];
      const env = { ...(previous?.env ?? {}) };
      if (typeof command.env === "object" && command.env !== null && !Array.isArray(command.env)) {
        for (const [key, value] of Object.entries(command.env as Record<string, unknown>)) {
          if (value === null) delete env[key];
          else if (typeof value === "string") env[key] = value;
        }
      }
      mockMcpServers[command.name] = { command: command.command, args: Array.isArray(command.args) ? command.args.filter((arg): arg is string => typeof arg === "string") : previous?.args ?? [], env };
      respond(type, command.id, { data: { server: safeMockMcpServers().find(server => server.name === command.name) } });
      return;
    }
    if (type === "mcp_remove") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: mcp_remove" }); return; }
      if (typeof command.name !== "string" || mockMcpServers[command.name] === undefined) { respond(type, command.id, { error: `MCP server not found: ${String(command.name)}` }); return; }
      delete mockMcpServers[command.name];
      respond(type, command.id);
      return;
    }
    if (type === "compact") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot compact while agent is running" }); return; }
      if (messageCount === 0) { respond(type, command.id, { error: "cannot compact empty history" }); return; }
      setTimeout(() => { messageCount = 1; respond(type, command.id); }, scenario.behavior === "slow-compaction" ? 600 : 10);
      return;
    }
    if (type === "cron_list") {
      if (scenario.behavior === "store-error") respond(type, command.id, { error: "mock store error: cron_list" });
      else {
        const available = scenario.behavior === "empty-stores" ? [] : cronJobs;
        if (command.cursor === undefined && command.limit === undefined && command.editableOnly === undefined && command.maxPromptLength === undefined) {
          respond(type, command.id, { data: { jobs: available } });
        } else {
          const cursor = typeof command.cursor === "number" ? command.cursor : 0;
          const limit = typeof command.limit === "number" ? command.limit : available.length;
          const page = available.slice(cursor, cursor + limit);
          const maxPromptLength = typeof command.maxPromptLength === "number" ? command.maxPromptLength : undefined;
          if (maxPromptLength !== undefined && page.some(job => job.prompt.length > maxPromptLength)) {
            respond(type, command.id, { error: `cron job prompt exceeds requested limit of ${String(maxPromptLength)}` });
          } else {
            const jobs = command.editableOnly === true ? page.map(({ id, schedule, prompt }) => ({ id, schedule, prompt })) : page;
            const nextCursor = cursor + page.length;
            respond(type, command.id, { data: { jobs, ...(nextCursor < available.length ? { nextCursor } : {}) } });
          }
        }
      }
      return;
    }
    if (type === "cron_add") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: cron_add" }); return; }
      const schedule = typeof command.schedule === "string" ? parseCronSchedule(command.schedule) : undefined;
      if (schedule === undefined || !schedule.valid || typeof command.prompt !== "string" || command.prompt.trim() === "") {
        respond(type, command.id, { error: "invalid cron job" }); return;
      }
      const job: MockCronJob = { id: `mock-cron-${String(nextCronJob++)}`, schedule: schedule.schedule, prompt: command.prompt.trim(), lastRun: null, requiredOutputs: [] };
      cronJobs = [...cronJobs, job];
      respond(type, command.id, { data: command.includeJob === false ? { jobId: job.id } : { job } });
      return;
    }
    if (type === "cron_update") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: cron_update" }); return; }
      const index = cronJobs.findIndex(job => job.id === command.jobId);
      const patch = typeof command.patch === "object" && command.patch !== null ? command.patch as Record<string, unknown> : undefined;
      const schedule = typeof patch?.schedule === "string" ? parseCronSchedule(patch.schedule) : undefined;
      if (index < 0) { respond(type, command.id, { error: `cron job not found: ${String(command.jobId)}` }); return; }
      if (schedule === undefined || !schedule.valid || typeof patch?.prompt !== "string" || patch.prompt.trim() === "") {
        respond(type, command.id, { error: "invalid cron update" }); return;
      }
      const current = cronJobs[index]!;
      const job = { ...current, schedule: schedule.schedule, prompt: patch.prompt.trim() };
      cronJobs = cronJobs.map(item => item.id === job.id ? job : item);
      respond(type, command.id, { data: command.includeJob === false ? { jobId: job.id } : { job } });
      return;
    }
    if (type === "cron_remove") {
      if (scenario.behavior === "store-error") { respond(type, command.id, { error: "mock store error: cron_remove" }); return; }
      if (!cronJobs.some(job => job.id === command.jobId)) { respond(type, command.id, { error: `cron job not found: ${String(command.jobId)}` }); return; }
      cronJobs = cronJobs.filter(job => job.id !== command.jobId);
      respond(type, command.id);
      return;
    }
    const emptyStoreData: Record<string, unknown> = {
      memory_list: { memories: [] }, memory_search: { memories: [] },
      notes_search: { notes: [] }, cron_list: { jobs: [] }, mcp_list: { servers: [] }, skills_list: { skills: [] },
    };
    if (type in emptyStoreData) {
      if (scenario.behavior === "store-error") respond(type, command.id, { error: `mock store error: ${type}` });
      else respond(type, command.id, { data: emptyStoreData[type] });
      return;
    }
    if (type === "prompt") {
      if (activePrompt !== undefined) {
        respond(type, command.id, { error: "agent is already running" });
        return;
      }
      const text = typeof command.message === "string" ? command.message : "";
      const messageIds = ensureMessageIds(activeSession);
      activeSession.messages.push({ role: "user", content: text });
      messageIds.push(nextMessageId++);
      messageCount = activeSession.messages.length + 1;
      activeSession.persistence = "unsaved";
      const prompt: ActivePrompt = { id: command.id, timers: new Set(), steering: [], followUp: [] };
      activePrompt = prompt;
      if (scenario.behavior === "approval" || scenario.behavior === "clarification" || scenario.behavior === "clarification-choice" || scenario.behavior === "clarification-free-text") {
        const kind = scenario.behavior === "approval" ? "approval" : "clarification";
        const requestId = `mock-${kind}-1`;
        activeInteraction = { kind, requestId, promptId: command.id };
        writeFragmented({ type: "agent_start" }, 8, prompt);
        writeFragmented(kind === "approval"
          ? { type: "approval_request", requestId, command: "sudo mock-command" }
          : {
            type: "clarification_request",
            requestId,
            question: scenario.behavior === "clarification-choice" ? "Which option should the mock use?" : "What should the mock use?",
            ...(scenario.behavior === "clarification-choice" ? { choices: ["Use the fast path", "Use the safe path"] } : {}),
          });
        return;
      }
      writeFragmented({ type: "agent_start" }, 8, prompt);
      if (scenario.behavior === "agent-activity") {
        const events: readonly unknown[] = [
          { type: "tool_execution_start", toolCallId: "todo-1", toolName: "todo", args: { todos: [] } },
          { type: "subagent_start", goal: "Inspect the desktop activity path", index: 0, count: 1 },
          { type: "tool_execution_start", toolCallId: "read-1", toolName: "read_file", args: { path: "README.md" } },
          { type: "tool_execution_start", toolCallId: "shell-1", toolName: "run_shell", args: { command: "exit 1" } },
          { type: "moa_reference_start", index: 0, count: 1, model: "mock-reference" },
          { type: "tool_execution_end", toolCallId: "read-1", toolName: "read_file", result: { toolCallId: "read-1", content: "Read README", isError: false } },
          { type: "tool_execution_end", toolCallId: "shell-1", toolName: "run_shell", result: { toolCallId: "shell-1", content: "exit code 1", isError: true } },
          { type: "tool_execution_end", toolCallId: "todo-1", toolName: "todo", result: { toolCallId: "todo-1", content: JSON.stringify({ todos: [{ id: "inspect", content: "Inspect activity", status: "completed" }, { id: "verify", content: "Verify UI", status: "in_progress" }] }), isError: false } },
          { type: "moa_reference_end", index: 0, model: "mock-reference", text: "Use accessible disclosure controls." },
          { type: "moa_aggregating", aggregator: "mock-aggregator", refCount: 1 },
          { type: "message_start", message: { role: "user", content: '<advisory severity="concern">Keep status text visible.</advisory>' } },
          { type: "subagent_end", goal: "Inspect the desktop activity path", index: 0, result: "Activity path inspected." },
          { type: "message_update", streamEvent: { type: "text_delta", delta: "Activity sequence complete." } },
          { type: "message_end", message: { role: "assistant", content: "Activity sequence complete." } },
          { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [], usage: { inputTokens: 1_200, outputTokens: 300 } },
          { type: "agent_end", messages: [] },
        ];
        events.forEach((event, index) => schedulePromptOutput(prompt, event, 10 + index * 10));
        const responseTimer = setTimeout(() => {
          prompt.timers.delete(responseTimer);
          if (activePrompt !== prompt) return;
          activePrompt = undefined;
          checkpointMockTurn("Activity sequence complete.");
          respond(type, command.id);
        }, 180);
        prompt.timers.add(responseTimer);
        return;
      }
      schedulePromptOutput(prompt, {
        type: "message_update",
        streamEvent: { type: "text_delta", delta: `## Mock response\n\nReceived **${text}**.\n\n` },
      }, 10);
      schedulePromptOutput(prompt, {
        type: "message_update",
        streamEvent: { type: "text_delta", delta: "| Mode | Status |\n| --- | --- |\n| desktop | ready |\n\n" },
      }, 12);
      schedulePromptOutput(prompt, {
        type: "message_update",
        streamEvent: { type: "text_delta", delta: "```ts\nconst streamed = true;\n```" },
      }, 14);
      if (scenario.behavior !== "cancellation") {
        schedulePromptOutput(prompt, {
          type: "message_end",
          message: { role: "assistant", content: "mock markdown response" },
        }, 70);
        schedulePromptOutput(prompt, {
          type: "turn_end",
          message: { role: "assistant", content: [] },
          toolResults: [],
          usage: { inputTokens: 1_200, outputTokens: 300 },
        }, 90);
        schedulePromptOutput(prompt, { type: "agent_end", messages: [] }, 120);
      }
      const responseTimer = setTimeout(() => {
        prompt.timers.delete(responseTimer);
        if (activePrompt !== prompt) return;
        activePrompt = undefined;
        checkpointMockTurn(`Mock response received ${text}.`);
        respond(type, command.id);
      }, scenario.behavior === "cancellation" ? 5_000 : 140);
      prompt.timers.add(responseTimer);
      return;
    }
    if (type === "steer" || type === "follow_up") {
      const prompt = activePrompt;
      const text = typeof command.message === "string" ? command.message.trim() : "";
      if (prompt === undefined || text === "") {
        respond(type, command.id, { error: prompt === undefined ? "Agent is not running" : "message is required" });
        return;
      }
      const queue = type === "steer" ? prompt.steering : prompt.followUp;
      queue.push(text);
      writeFragmented({ type: "queue_update", steering: prompt.steering, followUp: prompt.followUp }, 8, prompt);
      respond(type, command.id);
      schedulePromptOutput(prompt, { type: "message_start", message: { role: "user", content: text } }, 24);
      const dequeueTimer = setTimeout(() => {
        prompt.timers.delete(dequeueTimer);
        if (activePrompt !== prompt) return;
        queue.shift();
        writeFragmented({ type: "queue_update", steering: prompt.steering, followUp: prompt.followUp }, 8, prompt);
      }, 26);
      prompt.timers.add(dequeueTimer);
      return;
    }
    if (type === "approval_response" || type === "clarification_response") {
      const interaction = activeInteraction;
      const expected = type === "approval_response" ? "approval" : "clarification";
      if (interaction === undefined || interaction.kind !== expected || command.requestId !== interaction.requestId) {
        respond(type, command.id, { error: "unknown or mismatched interaction request" });
        return;
      }
      activeInteraction = undefined;
      activePrompt = undefined;
      checkpointMockTurn(type === "approval_response" && command.approved !== true
        ? "The mock shell command was denied."
        : "The mock interaction was resolved.");
      respond(type, command.id);
      writeFragmented({ type: "agent_end", messages: [] });
      if (type === "approval_response" && command.approved !== true) respond("prompt", interaction.promptId, { error: "shell command denied" });
      else respond("prompt", interaction.promptId);
      return;
    }
    if (type === "abort") {
      const prompt = activePrompt;
      if (prompt !== undefined) {
        activePrompt = undefined;
        activeInteraction = undefined;
        for (const timer of prompt.timers) clearTimeout(timer);
        prompt.timers.clear();
        for (let index = frameQueue.length - 1; index >= 0; index -= 1) {
          if (frameQueue[index]?.prompt === prompt) frameQueue.splice(index, 1);
        }
        writeFragmented({ type: "queue_update", steering: [], followUp: [] });
        writeFragmented({ type: "agent_end", messages: [] });
        checkpointMockTurn("The mock request was stopped.");
        respond("prompt", prompt.id);
      }
      respond(type, command.id);
      return;
    }
    respond(type, command.id, { error: `unknown command: ${type}` });
  });
}
