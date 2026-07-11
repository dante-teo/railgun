import { createInterface } from "node:readline/promises";
import { initFreshDevinSession } from "./session.js";
import { runTurn } from "./agent/turn.js";
import { IterationBudget } from "./agent/iterationBudget.js";
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

export const runOneShot = async (question: string): Promise<void> => {
  const session = await initFreshDevinSession();
  if (session === undefined) return;
  const { devin, model, systemPrompt } = session;
  let activeStop: ((isError: boolean) => void) | undefined;
  const todoStore = createTodoStore();
  const outcome = await runTurn(devin, model.id, model.contextWindow, systemPrompt, [], question, IterationBudget.create(), confirmShellCommand, {
    onDelta: delta => {
      process.stdout.write(delta);
    },
    onToolStart: (name, args) => {
      activeStop = startSpinner(buildToolLabel(name, args, "start"));
    },
    onToolComplete: (name, args, isError) => {
      activeStop?.(isError);
      activeStop = undefined;
    }
  }, { todoStore });
  if (outcome.ok) {
    process.stdout.write("\n");
  } else if (!("aborted" in outcome)) {
    throw outcome.error;
  }
};
