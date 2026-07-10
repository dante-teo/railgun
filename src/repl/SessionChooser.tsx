import React, { useCallback, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { SessionSummary } from "../persistence/sessionStore.js";

export type SelectionDirection = "up" | "down";

export const moveSessionSelection = (
  current: number,
  sessionCount: number,
  direction: SelectionDirection,
): number => {
  if (sessionCount <= 1) return 0;
  const delta = direction === "down" ? 1 : -1;
  return (current + delta + sessionCount) % sessionCount;
};

interface SessionChooserProps {
  sessions: readonly SessionSummary[];
  onDone: (sessionId: string | undefined) => void;
}

export const SessionChooser = ({ sessions, onDone }: SessionChooserProps): React.ReactElement => {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const finish = useCallback((sessionId: string | undefined) => {
    onDone(sessionId);
    exit();
  }, [exit, onDone]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(current => moveSessionSelection(current, sessions.length, "up"));
    } else if (key.downArrow) {
      setSelectedIndex(current => moveSessionSelection(current, sessions.length, "down"));
    } else if (key.return) {
      finish(sessions[selectedIndex]?.id);
    } else if (key.escape || (key.ctrl && input.toLowerCase() === "c")) {
      finish(undefined);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Resume a session</Text>
      <Text dimColor>↑/↓ select · Enter resume · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.map((session, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={session.id} flexDirection="column" marginBottom={index === sessions.length - 1 ? 0 : 1}>
              <Text inverse={selected} bold={selected}>
                {selected ? "❯ " : "  "}{session.firstUserPreview || "(no user message)"}
              </Text>
              <Text dimColor={!selected}>
                {"  "}{session.startedAtLocal} · {session.messageCount} msgs · {session.model} · {session.id}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export const runSessionChooser = (sessions: readonly SessionSummary[]): Promise<string | undefined> => {
  const result = Promise.withResolvers<string | undefined>();
  let settled = false;
  const settle = (sessionId: string | undefined): void => {
    if (settled) return;
    settled = true;
    result.resolve(sessionId);
  };
  const instance = render(
    <SessionChooser sessions={sessions} onDone={settle} />,
    { exitOnCtrlC: false },
  );
  instance.waitUntilExit().then(() => settle(undefined), () => settle(undefined));
  return result.promise;
};
