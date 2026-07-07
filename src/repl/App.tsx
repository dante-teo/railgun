import React, { useCallback, useState } from "react";
import { Box, render, Static, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import type { DevinMessage } from "widevin";
import { runTurn } from "../agent/turn.js";
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

      const outcome = await runTurn(session.devin, session.model.id, history, text, delta => {
        setStreaming(prev => prev + delta);
      });

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
    [history, session, exit]
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
      <Box>
        <Text>{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} focus={!busy} />
      </Box>
    </Box>
  );
};

export const runRepl = async (session: DevinSession): Promise<void> => {
  const instance = render(<ChatApp session={session} />);
  await instance.waitUntilExit();
};
