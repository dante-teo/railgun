import { createInterface } from "node:readline/promises";
import { initDevinSession } from "./session.js";
import { runTurn } from "./agent/turn.js";
import { IterationBudget } from "./agent/iterationBudget.js";
import { startSpinner } from "./spinner.js";
import { buildToolLabel } from "./tools/toolLabel.js";

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
  const { devin, model, systemPrompt } = await initDevinSession();
  let activeStop: ((isError: boolean) => void) | undefined;
  const outcome = await runTurn(devin, model.id, systemPrompt, [], question, IterationBudget.create(), confirmShellCommand, {
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
  });
  if (outcome.ok) {
    process.stdout.write("\n");
  } else {
    throw outcome.error;
  }
};
