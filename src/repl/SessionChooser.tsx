import React, { useCallback, useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { SessionSummary } from "../persistence/sessionStore.js";
import { runInAlternateScreen, shouldUseAlternateScreen } from "./lifecycle.js";
import { ThemeController, themeForMode } from "./theme.js";
import type { ThemeMode } from "./theme.js";
import { useTerminalSize } from "./terminalSize.js";

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

export const sessionListWindow = (
  selectedIndex: number,
  sessionCount: number,
  visibleRows: number,
): { readonly start: number; readonly end: number } => {
  const size = Math.max(1, Math.min(sessionCount, visibleRows));
  const start = Math.max(0, Math.min(selectedIndex - size + 1, sessionCount - size));
  return { start, end: Math.min(sessionCount, start + size) };
};

interface SessionChooserProps {
  readonly sessions: readonly SessionSummary[];
  readonly onDone: (sessionId: string | undefined) => void;
  readonly initialMode: ThemeMode;
  readonly themeController: ThemeController;
}

export const SessionChooser = ({ sessions, onDone, initialMode, themeController }: SessionChooserProps): React.ReactElement => {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState(initialMode);
  const size = useTerminalSize();
  const theme = themeForMode(mode);
  useEffect(() => themeController.subscribe(setMode), [themeController]);

  const finish = useCallback((sessionId: string | undefined) => {
    onDone(sessionId);
    exit();
  }, [exit, onDone]);

  useInput((input, key) => {
    if (key.upArrow) setSelectedIndex(current => moveSessionSelection(current, sessions.length, "up"));
    else if (key.downArrow) setSelectedIndex(current => moveSessionSelection(current, sessions.length, "down"));
    else if (key.return) finish(sessions[selectedIndex]?.id);
    else if (key.escape || (key.ctrl && input.toLowerCase() === "c")) finish(undefined);
  });

  const visibleCount = Math.max(1, Math.floor((size.rows - 5) / 3));
  const window = sessionListWindow(selectedIndex, sessions.length, visibleCount);
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} height={3}>
        <Text color={theme.strong} bold>RAILGUN</Text>
        <Text color={theme.muted}> · resume session</Text>
      </Box>
      <Text color={theme.dim}> ↑/↓ select · Enter resume · Esc cancel</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {sessions.slice(window.start, window.end).map((session, visibleIndex) => {
          const index = window.start + visibleIndex;
          const selected = index === selectedIndex;
          return (
            <Box key={session.id} flexDirection="column" backgroundColor={selected ? theme.selection : undefined} paddingX={1}>
              <Text color={selected ? theme.strong : theme.text} bold={selected} wrap="truncate-end">
                {selected ? "❯ " : "  "}{session.firstUserPreview || "(no user message)"}
              </Text>
              <Text color={selected ? theme.muted : theme.dim} wrap="truncate-end">
                {"  "}{session.startedAtLocal} · {session.messageCount} msgs · {session.model} · {session.id}
              </Text>
              <Text color={theme.border}>{"─".repeat(Math.max(1, size.columns - 2))}</Text>
            </Box>
          );
        })}
      </Box>
      <Box backgroundColor={theme.statusSurface} paddingX={1} height={1}>
        <Text color={theme.accent}>sessions {sessions.length}</Text>
        <Text color={theme.dim}> · {selectedIndex + 1}/{sessions.length}</Text>
      </Box>
    </Box>
  );
};

export const runSessionChooser = async (sessions: readonly SessionSummary[]): Promise<string | undefined> => {
  const result = Promise.withResolvers<string | undefined>();
  let settled = false;
  const settle = (sessionId: string | undefined): void => {
    if (settled) return;
    settled = true;
    result.resolve(sessionId);
  };
  const controller = new ThemeController();
  const initialMode = await controller.start();
  const screenReaderEnabled = process.env["INK_SCREEN_READER"] === "true";
  const alternate = shouldUseAlternateScreen(process.stdout.isTTY === true, screenReaderEnabled);
  try {
    await runInAlternateScreen(sequence => process.stdout.write(sequence), alternate, async () => {
      const instance = render(
        <SessionChooser sessions={sessions} onDone={settle} initialMode={initialMode} themeController={controller} />,
        {
          exitOnCtrlC: false,
          isScreenReaderEnabled: screenReaderEnabled,
        },
      );
      await instance.waitUntilExit().then(() => settle(undefined), () => settle(undefined));
    });
  } finally {
    await controller.dispose();
    settle(undefined);
  }
  return result.promise;
};
