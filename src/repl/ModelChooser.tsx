import React, { useCallback, useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { DevinModel } from "widevin";
import { runInAlternateScreen, shouldUseAlternateScreen } from "./lifecycle.js";
import { createSelectionInputState, selectionListWindow } from "./SessionChooser.js";
import { ThemeController, themeForMode } from "./theme.js";
import type { Theme, ThemeMode } from "./theme.js";
import { useTerminalSize } from "./terminalSize.js";

const compactCount = (count: number): string =>
  count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count);

export const modelMetadata = (model: DevinModel): string => [
  model.id,
  model.input.includes("image") ? "images" : "text only",
  model.reasoning ? "reasoning" : "standard",
  `${compactCount(model.contextWindow)} context`,
  `${compactCount(model.maxTokens)} output`,
].join(" · ");

interface ModelRowProps {
  readonly model: DevinModel;
  readonly selected: boolean;
  readonly theme: Theme;
  readonly columns: number;
}

export const ModelRow = ({ model, selected, theme, columns }: ModelRowProps): React.ReactElement => (
  <Box flexDirection="column" backgroundColor={selected ? theme.selection : undefined} paddingX={1}>
    <Text color={selected ? theme.strong : theme.text} bold={selected} wrap="truncate-end">
      {selected ? "❯ " : "  "}{model.name}
    </Text>
    <Text color={selected ? theme.muted : theme.dim} wrap="truncate-end">
      {"  "}{modelMetadata(model)}
    </Text>
    <Text color={theme.border}>{"─".repeat(Math.max(1, columns - 2))}</Text>
  </Box>
);

interface ModelChooserProps {
  readonly models: readonly DevinModel[];
  readonly unavailableId: string;
  readonly onDone: (modelId: string | undefined) => void;
  readonly initialMode: ThemeMode;
  readonly themeController: ThemeController;
}

export const ModelChooser = ({ models, unavailableId, onDone, initialMode, themeController }: ModelChooserProps): React.ReactElement => {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectionInput] = useState(createSelectionInputState);
  const [mode, setMode] = useState(initialMode);
  const size = useTerminalSize();
  const theme = themeForMode(mode);
  useEffect(() => themeController.subscribe(setMode), [themeController]);

  const finish = useCallback((modelId: string | undefined) => {
    onDone(modelId);
    exit();
  }, [exit, onDone]);

  useInput((input, key) => {
    const action = selectionInput.reduce(models.length, input, key);
    if (action.type === "move") setSelectedIndex(action.index);
    else if (action.type === "finish") finish(models[action.index]?.id);
    else if (action.type === "cancel") finish(undefined);
  });

  const visibleCount = Math.max(1, Math.floor((size.rows - 6) / 3));
  const window = selectionListWindow(selectedIndex, models.length, visibleCount);
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} height={3}>
        <Text color={theme.strong} bold>RAILGUN</Text>
        <Text color={theme.muted}> · choose replacement model</Text>
      </Box>
      <Text color={theme.warning} wrap="truncate-end"> Configured model unavailable: {unavailableId}</Text>
      <Text color={theme.dim}> ↑/↓ select · Enter use and save · Esc cancel</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {models.slice(window.start, window.end).map((model, visibleIndex) => (
          <ModelRow key={model.id} model={model} selected={window.start + visibleIndex === selectedIndex} theme={theme} columns={size.columns} />
        ))}
      </Box>
      <Box backgroundColor={theme.statusSurface} paddingX={1} height={1}>
        <Text color={theme.accent}>models {models.length}</Text>
        <Text color={theme.dim}> · {selectedIndex + 1}/{models.length}</Text>
      </Box>
    </Box>
  );
};

export const runModelChooser = async (models: readonly DevinModel[], unavailableId: string): Promise<string | undefined> => {
  const result = Promise.withResolvers<string | undefined>();
  let settled = false;
  const settle = (modelId: string | undefined): void => {
    if (settled) return;
    settled = true;
    result.resolve(modelId);
  };
  const controller = new ThemeController();
  const initialMode = await controller.start();
  const screenReaderEnabled = process.env["INK_SCREEN_READER"] === "true";
  const alternate = shouldUseAlternateScreen(process.stdout.isTTY === true, screenReaderEnabled);
  try {
    await runInAlternateScreen(sequence => process.stdout.write(sequence), alternate, async () => {
      const instance = render(
        <ModelChooser models={models} unavailableId={unavailableId} onDone={settle} initialMode={initialMode} themeController={controller} />,
        { exitOnCtrlC: false, isScreenReaderEnabled: screenReaderEnabled },
      );
      await instance.waitUntilExit().then(() => settle(undefined), () => settle(undefined));
    });
  } finally {
    await controller.dispose();
    settle(undefined);
  }
  return result.promise;
};
