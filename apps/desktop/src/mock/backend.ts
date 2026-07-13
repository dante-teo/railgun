import { createInterface } from "node:readline";
import { getMockScenario } from "./scenarios";

const scenario = getMockScenario(process.argv[2] ?? "ready-idle");
let messageCount = 0;
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
            running: false,
            model: "mock-model",
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
      const prompt: ActivePrompt = { id: command.id, timers: new Set() };
      activePrompt = prompt;
      if (scenario.behavior === "approval" || scenario.behavior === "clarification") {
        const kind = scenario.behavior;
        const requestId = `mock-${kind}-1`;
        activeInteraction = { kind, requestId, promptId: command.id };
        writeFragmented(kind === "approval"
          ? { type: "approval_request", requestId, command: "sudo mock-command" }
          : { type: "clarification_request", requestId, question: "Which option should the mock use?" });
        return;
      }
      writeFragmented({ type: "agent_start" }, 8, prompt);
      schedulePromptOutput(prompt, {
        type: "message_update",
        streamEvent: { type: "text_delta", delta: `Mock Railgun received: ${text}` },
      }, 10);
      schedulePromptOutput(prompt, { type: "agent_end", messages: [] }, 20);
      const responseTimer = setTimeout(() => {
        prompt.timers.delete(responseTimer);
        if (activePrompt !== prompt) return;
        activePrompt = undefined;
        respond(type, command.id);
      }, scenario.behavior === "cancellation" ? 5_000 : 30);
      prompt.timers.add(responseTimer);
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
        writeFragmented({ type: "agent_end", messages: [] });
        respond("prompt", prompt.id);
      }
      respond(type, command.id);
      return;
    }
    respond(type, command.id, { error: `unknown command: ${type}` });
  });
}
