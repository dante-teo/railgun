import React, { useCallback, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { DevinMessage } from "widevin";
import { runTurn } from "../agent/turn.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { describeDevinError } from "../errors.js";
import type { DevinSession } from "../session.js";

interface DisplayLine {
  kind: "user" | "assistant" | "error";
  text: string;
}

const ChatApp = ({ session }: { session: DevinSession }): React.ReactElement => {
  const { exit } = useApp();
  const [history, setHistory] = useState<readonly DevinMessage[]>([]);
  const [lines, setLines] = useState<readonly DisplayLine[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const iterationBudgetRef = useRef(IterationBudget.create());
  const pendingApprovalRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);

  const confirmShellCommand = useCallback((command: string): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    pendingApprovalRef.current = { resolve };
    setPendingCommand(command);
    return promise;
  }, []);

  useInput(
    (input, key) => {
      const pending = pendingApprovalRef.current;
      if (!pending) return;
      if (input.toLowerCase() === "y") {
        pending.resolve(true);
      } else if (input.toLowerCase() === "n" || key.escape) {
        pending.resolve(false);
      } else {
        return;
      }
      pendingApprovalRef.current = null;
      setPendingCommand(null);
    },
    { isActive: pendingCommand !== null }
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (text === "") return;
      if (text === "/exit") {
        exit();
        return;
      }

      setLines(prev => [...prev, { kind: "user", text }]);
      setBusy(true);
      setStreaming("");

      const outcome = await runTurn(
        session.devin,
        session.model.id,
        history,
        text,
        iterationBudgetRef.current,
        confirmShellCommand,
        delta => {
          setStreaming(prev => prev + delta);
        }
      );

      if (outcome.ok) {
        setHistory(outcome.messages);
        setLines(prev => [...prev, { kind: "assistant", text: outcome.assistantText }]);
      } else {
        const message = describeDevinError(outcome.error) ?? String(outcome.error);
        setLines(prev => [...prev, { kind: "error", text: message }]);
      }

      setStreaming("");
      setBusy(false);
    },
    [history, session, exit, confirmShellCommand]
  );

  return (
    <Box flexDirection="column">
      <Static items={[...lines]}>
        {(line, index) => (
          <Text key={index} {...(line.kind === "error" ? { color: "red" as const } : {})}>
            {line.kind === "user" ? `> ${line.text}` : line.text}
          </Text>
        )}
      </Static>
      {busy && <Text color="cyan">{streaming || "…"}</Text>}
      {pendingCommand !== null && (
        <Text color="yellow">Run shell command: {pendingCommand} [y/n]</Text>
      )}
      <Box>
        <Text>{"> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          focus={!busy && pendingCommand === null}
        />
      </Box>
    </Box>
  );
};

export const runRepl = async (session: DevinSession): Promise<void> => {
  const instance = render(<ChatApp session={session} />);
  await instance.waitUntilExit();
};
