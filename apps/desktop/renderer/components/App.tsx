import React, { useMemo, useCallback } from "react";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { TodoPanel } from "./TodoPanel.js";
import { StatusBar } from "./StatusBar.js";
import { useComposer } from "../hooks/useComposer.js";
import {
  ModelPicker,
  TrustPicker,
  ClarifyPrompt,
  ShellApproval,
  ActionPicker,
  SessionChooser,
} from "./overlays/index.js";
import type { TrustPickerItem } from "./overlays/index.js";
import { useAgentEvents, SETTINGS_ITEMS } from "../lib/useAgentEvents.js";
import { applyTheme } from "../lib/theme.js";

const TRUST_CHOICES: readonly TrustPickerItem[] = [
  { label: "Trust", value: "trust" },
  { label: "Trust (this session only)", value: "trust-session" },
  { label: "Do not trust", value: "deny" },
];

export const App: React.FC = () => {
  const state = useAgentEvents(
    import.meta.env.VITE_GATEWAY_URL ?? "ws://localhost:9400",
  );
  const composer = useComposer();

  const dismissOverlay = useCallback((): void => {
    state.setOverlay(null);
  }, [state]);

  const handleModelConfirm = useCallback((index: number): void => {
    const model = state.availableModels[index];
    if (model !== undefined) {
      state.setModel(model.id);
    }
    dismissOverlay();
  }, [state, dismissOverlay]);

  const handleSettingsConfirm = useCallback((index: number): void => {
    const item = SETTINGS_ITEMS[index];
    if (item?.id === "theme") {
      // data-theme="light" means light is applied; absent means dark.
      const currentIsDark = document.documentElement.getAttribute("data-theme") !== "light";
      applyTheme(currentIsDark ? "light" : "dark");
    } else {
      console.log("[App] Settings action:", item?.id);
    }
    dismissOverlay();
  }, [dismissOverlay]);

  const renderOverlay = (): React.ReactNode => {
    const { overlay } = state;
    if (overlay === null) return null;

    switch (overlay.kind) {
      case "model":
        return (
          <ModelPicker
            models={state.availableModels}
            selectedIndex={overlay.selectedIndex}
            sessionOnly={false}
            onNavigate={state.navigateOverlay}
            onConfirm={handleModelConfirm}
            onCancel={dismissOverlay}
          />
        );
      case "approval":
        return (
          <ShellApproval
            command={state.pendingCommand ?? ""}
            onApprove={() => state.approveCommand(true)}
            onDeny={() => state.approveCommand(false)}
          />
        );
      case "clarify":
        return (
          <ClarifyPrompt
            question={state.pendingClarify?.question ?? ""}
            choices={state.pendingClarify?.choices}
            onAnswer={state.answerClarify}
            onDismiss={dismissOverlay}
          />
        );
      case "action":
        return (
          <ActionPicker
            title="Settings"
            items={[...SETTINGS_ITEMS]}
            selectedIndex={overlay.selectedIndex}
            onNavigate={state.navigateOverlay}
            onConfirm={handleSettingsConfirm}
            onCancel={dismissOverlay}
          />
        );
      case "trust":
        return (
          <TrustPicker
            choices={TRUST_CHOICES}
            selectedIndex={overlay.selectedIndex}
            onNavigate={state.navigateOverlay}
            onConfirm={dismissOverlay}
            onCancel={dismissOverlay}
          />
        );
      case "session":
        return (
          <SessionChooser
            sessions={[]}
            selectedIndex={overlay.selectedIndex}
            onNavigate={state.navigateOverlay}
            onConfirm={dismissOverlay}
            onCancel={dismissOverlay}
          />
        );
    }
  };

  // Ephemeral lines: pending tool calls shown while the agent is running.
  // Streaming text is NOT added here — Transcript renders it directly via
  // its `streaming` prop (adding it here too would duplicate the bubble).
  const displayLines = useMemo((): readonly DisplayLine[] => {
    if (!state.busy || state.toolLabels.size === 0) return state.lines;

    const ephemeral: DisplayLine[] = [];
    for (const [, label] of state.toolLabels) {
      ephemeral.push({ kind: "tool", text: label, pending: true });
    }
    return [...state.lines, ...ephemeral];
  }, [state.lines, state.toolLabels, state.busy]);

  return (
    <div className="app">
      <header className="header">
        <span className="header__wordmark">RAILGUN</span>
        {state.connected !== "connected" && (
          <span
            style={{
              fontSize: 11,
              color: "var(--color-warning)",
              fontFamily: "var(--font-mono)",
              marginLeft: "auto",
            }}
          >
            Reconnecting…
          </span>
        )}
      </header>

      <Transcript lines={displayLines} streaming={state.streaming} busy={state.busy} />

      <div className="bottom-stack">
        <TodoPanel todos={state.todos} isLoading={state.todoLoading} />

        <div className="overlay-zone">{renderOverlay()}</div>

        <Composer
          state={composer}
          mode={state.composerMode}
          onSubmit={state.submit}
          onAbort={state.abort}
        />

        <StatusBar
          model={state.model}
          gitStatus={state.gitStatus}
          cwd={state.cwd}
          unsaved={false}
          activeMoaPreset={state.activeMoaPreset}
        />
      </div>
    </div>
  );
};
