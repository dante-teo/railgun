import { createInterface } from "node:readline/promises";
import { initDevinSession } from "./session.js";
import { runTurn } from "./agent/turn.js";

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
  const { devin, model } = await initDevinSession();
  const outcome = await runTurn(devin, model.id, [], question, confirmShellCommand, delta => {
    process.stdout.write(delta);
  });
  if (outcome.ok) {
    process.stdout.write("\n");
  } else {
    throw outcome.error;
  }
};
