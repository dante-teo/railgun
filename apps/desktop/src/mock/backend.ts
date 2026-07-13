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

if (scenario.behavior === "crash-before-ready") {
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
            todos: { items: [] },
          },
        });
        if (scenario.behavior === "disconnect-after-ready") {
          setTimeout(() => process.exit(23), 80);
        }
      };
      setTimeout(sendState, scenario.behavior === "delayed-startup" ? 600 : 15);
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
      }, 30);
      prompt.timers.add(responseTimer);
      return;
    }
    if (type === "abort") {
      const prompt = activePrompt;
      if (prompt !== undefined) {
        activePrompt = undefined;
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
