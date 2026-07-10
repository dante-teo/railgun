import React, { useCallback, useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { SessionSummary } from "../persistence/sessionStore.js";
import { runInAlternateScreen, shouldUseAlternateScreen } from "./lifecycle.js";
import { ThemeController, themeForMode } from "./theme.js";
import type { ThemeMode } from "./theme.js";
import { useTerminalSize } from "./terminalSize.js";

export type SelectionDirection = "up" | "down";

interface SelectionKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
}

export type SelectionInputResult =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "finish"; readonly index: number }
  | { readonly type: "cancel" }
  | { readonly type: "none" };

export const moveSelection = (
  current: number,
  itemCount: number,
  direction: SelectionDirection,
): number => {
  if (itemCount <= 1) return 0;
  const delta = direction === "down" ? 1 : -1;
  return (current + delta + itemCount) % itemCount;
};

export const selectionListWindow = (
  selectedIndex: number,
  itemCount: number,
  visibleRows: number,
): { readonly start: number; readonly end: number } => {
  const size = Math.max(1, Math.min(itemCount, visibleRows));
  const start = Math.max(0, Math.min(selectedIndex - size + 1, itemCount - size));
  return { start, end: Math.min(itemCount, start + size) };
};

// Backward-compatible names retained for callers and tests from the resume chooser.
export const moveSessionSelection = moveSelection;
export const sessionListWindow = selectionListWindow;

export const reduceSelectionInput = (
  current: number,
  itemCount: number,
  input: string,
  key: SelectionKey,
): SelectionInputResult => {
  if (key.upArrow) return { type: "move", index: moveSelection(current, itemCount, "up") };
  if (key.downArrow) return { type: "move", index: moveSelection(current, itemCount, "down") };
  if (key.return) return { type: "finish", index: current };
  if (key.escape || (key.ctrl && input.toLowerCase() === "c")) return { type: "cancel" };
  return { type: "none" };
};

export const createSelectionInputState = (initialIndex = 0) => {
  let currentIndex = initialIndex;
  return {
    reduce: (itemCount: number, input: string, key: SelectionKey): SelectionInputResult => {
      const action = reduceSelectionInput(currentIndex, itemCount, input, key);
      if (action.type === "move") currentIndex = action.index;
      return action;
    },
  };
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
  const [selectionInput] = useState(createSelectionInputState);
  const [mode, setMode] = useState(initialMode);
  const size = useTerminalSize();
  const theme = themeForMode(mode);
  useEffect(() => themeController.subscribe(setMode), [themeController]);

  const finish = useCallback((sessionId: string | undefined) => {
    onDone(sessionId);
    exit();
  }, [exit, onDone]);

  useInput((input, key) => {
    const action = selectionInput.reduce(sessions.length, input, key);
    if (action.type === "move") setSelectedIndex(action.index);
    else if (action.type === "finish") finish(sessions[action.index]?.id);
    else if (action.type === "cancel") finish(undefined);
  });

  const visibleCount = Math.max(1, Math.floor((size.rows - 5) / 3));
  const window = selectionListWindow(selectedIndex, sessions.length, visibleCount);
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
