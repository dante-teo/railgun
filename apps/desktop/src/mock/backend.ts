import { createInterface } from "node:readline";
import { getMockScenario } from "./scenarios";

const scenario = getMockScenario(process.argv[2] ?? "ready-idle");
let messageCount = 0;

const writeFragmented = (value: unknown, delayMs = 8): void => {
  const line = `${JSON.stringify(value)}\n`;
  const splitAt = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, splitAt));
  setTimeout(() => process.stdout.write(line.slice(splitAt)), delayMs);
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
      messageCount += 2;
      respond(type, command.id);
      return;
    }
    if (type === "abort") {
      respond(type, command.id);
      return;
    }
    respond(type, command.id, { error: `unknown command: ${type}` });
  });
}
