import { createInterface } from "node:readline/promises";
import { initFreshDevinSession } from "./session.js";
import { createAgentSession } from "./agent/agentSession.js";
import { startSpinner } from "./spinner.js";
import { buildToolLabel } from "./tools/toolLabel.js";
import { createTodoStore } from "./tools/todo.js";

const confirmShellCommand = async (command: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Run shell command: ${command}\nType "yes" to run, anything else to cancel: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
};

const clarifyCallback = async (question: string, choices?: string[]): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`\n❓ ${question}`);
    if (choices && choices.length > 0) {
      choices.forEach((c, i) => console.error(`  ${i + 1}. ${c}`));
      const answer = await rl.question("Pick a number, or type your own answer: ");
      const idx = parseInt(answer, 10) - 1;
      return (idx >= 0 && idx < choices.length) ? choices[idx] ?? answer : answer;
    }
    return await rl.question("Your answer: ");
  } finally {
    rl.close();
  }
};

export const runOneShot = async (question: string): Promise<void> => {
  const session = await initFreshDevinSession();
  if (session === undefined) return;
  const { devin, model, systemPrompt } = session;
  const todoStore = createTodoStore();
  const agentSession = createAgentSession({
    devin, model: model.id, contextWindow: model.contextWindow, systemPrompt, confirmShellCommand, clarifyCallback, todoStore,
  });

  const activeStops = new Map<string, (isError: boolean) => void>();
  const staticLabels = new Map<string, string>();
  let animatedCallId: string | undefined;

  agentSession.subscribe(event => {
    if (event.type === "message_update" && event.streamEvent.type === "text_delta") {
      process.stdout.write(event.streamEvent.delta);
    } else if (event.type === "tool_execution_start") {
      const label = buildToolLabel(event.toolName, event.args);
      if (animatedCallId === undefined) {
        animatedCallId = event.toolCallId;
        activeStops.set(event.toolCallId, startSpinner(label));
      } else {
        staticLabels.set(event.toolCallId, label);
        process.stderr.write(`${label}...\n`);
      }
    } else if (event.type === "tool_execution_end") {
      const stop = activeStops.get(event.toolCallId);
      if (stop !== undefined) {
        stop(event.result.isError);
        activeStops.delete(event.toolCallId);
        animatedCallId = undefined;
      } else {
        const label = staticLabels.get(event.toolCallId) ?? event.toolName;
        staticLabels.delete(event.toolCallId);
        process.stderr.write(`${event.result.isError ? "✘" : "✔"} ${label}\n`);
      }
    }
  });

  const outcome = await agentSession.run({ history: [], text: question });
  if (outcome.ok) {
    process.stdout.write("\n");
  } else if (!("aborted" in outcome)) {
    throw outcome.error;
  }
};
