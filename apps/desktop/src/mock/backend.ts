import { createInterface } from "node:readline";
import { getMockScenario } from "./scenarios";

const scenario = getMockScenario(process.argv[2] ?? "ready-idle");
let messageCount = 0;
let activeModel = "mock-model";
let config: Record<string, unknown> = {
  model: "mock-model",
  defaultProjectTrust: "ask",
  moaPresets: {
    review: {
      referenceModels: [{ model: "mock-reference" }],
      aggregator: { model: "mock-model" },
      referenceMaxTokens: 4_000,
    },
  },
  advisor: { enabled: false, model: "mock-reference" },
};
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
            todos: [],
            protocolVersion: 1,
            sessionId: "mock-session",
            persistence: "unsaved",
          },
        });
        if (scenario.behavior === "disconnect-after-ready") {
          setTimeout(() => process.exit(23), 80);
        }
      };
      setTimeout(sendState, scenario.behavior === "delayed-startup" ? 600 : 15);
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
      else { activeModel = command.modelId; respond(type, command.id); }
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
    if (type === "compact") {
      if (activePrompt !== undefined) { respond(type, command.id, { error: "cannot compact while agent is running" }); return; }
      if (messageCount === 0) { respond(type, command.id, { error: "cannot compact empty history" }); return; }
      setTimeout(() => { messageCount = 1; respond(type, command.id); }, scenario.behavior === "slow-compaction" ? 600 : 10);
      return;
    }
    const emptyStoreData: Record<string, unknown> = {
      session_list: { sessions: [] }, memory_list: { memories: [] }, memory_search: { memories: [] },
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
      messageCount += 2;
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
        respond("prompt", prompt.id);
      }
      respond(type, command.id);
      return;
    }
    respond(type, command.id, { error: `unknown command: ${type}` });
  });
}
