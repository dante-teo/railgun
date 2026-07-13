import type React from "react";
import { useEffect, useState } from "react";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import type { TodoState } from "@railgun/core/tools/todo.js";
import type { DevinModel } from "widevin";
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

const MOCK_LINES: readonly DisplayLine[] = [
  { kind: "user", text: "Hello, what can you do?" },
  { kind: "assistant", text: "I'm **Railgun**, your AI agent. I can help you with:\n\n- Writing and editing code\n- Running shell commands\n- Searching files and the web\n- Managing tasks with my todo list\n\nTry typing `/help` for available commands." },
  { kind: "tool", text: "bash(echo hello)", pending: false, failed: false },
  { kind: "tool", text: "read(src/main.ts)", pending: true },
  { kind: "tool", text: "write(output.txt)", pending: false, failed: true },
  { kind: "error", text: "Tool execution failed: permission denied" },
  { kind: "advisory", severity: "concern", text: "This operation modifies files outside the project root." },
  { kind: "advisory", severity: "blocker", text: "Cannot proceed: the working directory has uncommitted changes." },
  { kind: "advisory", severity: "nit", text: "Consider adding a .gitignore entry for dist/." },
  { kind: "user", text: "Can you show me the todo list?" },
  { kind: "assistant", text: "Sure, I've set up some sample tasks:" },
];

const MOCK_TODOS: TodoState = [
  { id: "1", content: "Scaffold monorepo and desktop package", status: "completed" },
  { id: "2", content: "Build WebSocket gateway", status: "completed" },
  { id: "3", content: "Create renderer components", status: "in_progress" },
  { id: "4", content: "Wire gateway client in renderer", status: "pending" },
  { id: "5", content: "Package as Electron app", status: "pending" },
];

const MOCK_MODELS = [
  { id: "claude-sonnet-4" },
  { id: "claude-opus-4" },
  { id: "gpt-4o" },
  { id: "o3" },
  { id: "gemini-2.5-pro" },
] as unknown as DevinModel[];

const MOCK_TRUST_CHOICES: readonly TrustPickerItem[] = [
  { label: "Trust", value: "trust" },
  { label: "Trust (this session only)", value: "trust-session" },
  { label: "Do not trust", value: "deny" },
];

type OverlayKind =
  | "model"
  | "trust"
  | "clarify-choices"
  | "clarify-text"
  | "approval"
  | "action"
  | "session"
  | null;

const OVERLAY_KEYS: Record<string, Exclude<OverlayKind, null>> = {
  "1": "model",
  "2": "trust",
  "3": "clarify-choices",
  "4": "clarify-text",
  "5": "approval",
  "6": "action",
  "7": "session",
};

export const DevShell: React.FC = () => {
  const [lines, setLines] = useState<DisplayLine[]>([...MOCK_LINES]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const composer = useComposer();

  const [activeOverlay, setActiveOverlay] = useState<OverlayKind>(null);
  const [overlayIndex, setOverlayIndex] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (activeOverlay !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const kind = OVERLAY_KEYS[e.key];
      if (kind !== undefined) {
        setOverlayIndex(0);
        setActiveOverlay(kind);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeOverlay]);

  const dismiss = (): void => setActiveOverlay(null);
  const confirm = (label: string) => (index: number): void => {
    console.log(`[DevShell] ${label} confirmed index=${index}`);
    dismiss();
  };
  const answer = (label: string) => (text: string): void => {
    console.log(`[DevShell] ${label} answered: ${text}`);
    dismiss();
  };

  const handleSubmit = (text: string): void => {
    if (busy) return;
    setLines(prev => [...prev, { kind: "user", text }]);
    setBusy(true);
    setStreaming("");

    // Simulate thinking → streaming → finalized
    const words = `_[dev mode]_ Echo: ${text}`.split(" ");
    let accumulated = "";
    let wordIndex = 0;

    const tick = (): void => {
      if (wordIndex < words.length) {
        accumulated += (wordIndex > 0 ? " " : "") + words[wordIndex];
        wordIndex++;
        setStreaming(accumulated);
        setTimeout(tick, 150);
      } else {
        // Finalize
        setLines(prev => [...prev, { kind: "assistant", text: accumulated }]);
        setStreaming("");
        setBusy(false);
      }
    };

    // Brief thinking pause before first word
    setTimeout(tick, 600);
  };

  const renderOverlay = (): React.ReactNode => {
    switch (activeOverlay) {
      case "model":
        return (
          <ModelPicker
            models={MOCK_MODELS}
            selectedIndex={overlayIndex}
            sessionOnly={false}
            onNavigate={setOverlayIndex}
            onConfirm={confirm("ModelPicker")}
            onCancel={dismiss}
          />
        );
      case "trust":
        return (
          <TrustPicker
            choices={MOCK_TRUST_CHOICES}
            selectedIndex={overlayIndex}
            onNavigate={setOverlayIndex}
            onConfirm={confirm("TrustPicker")}
            onCancel={dismiss}
          />
        );
      case "clarify-choices":
        return (
          <ClarifyPrompt
            question="Which direction should we take?"
            choices={["Option A — fast path", "Option B — safe path", "Option C — hybrid"]}
            onAnswer={answer("ClarifyPrompt(choices)")}
            onDismiss={dismiss}
          />
        );
      case "clarify-text":
        return (
          <ClarifyPrompt
            question="What is the target directory?"
            onAnswer={answer("ClarifyPrompt(text)")}
            onDismiss={dismiss}
          />
        );
      case "approval":
        return (
          <ShellApproval
            command="rm -rf /tmp/railgun-cache && npm ci"
            onApprove={() => { console.log("[DevShell] ShellApproval approved"); dismiss(); }}
            onDeny={() => { console.log("[DevShell] ShellApproval denied"); dismiss(); }}
          />
        );
      case "action":
        return (
          <ActionPicker
            title="Settings"
            items={[
              { id: "model", label: "Change model", detail: "claude-sonnet-4", current: false },
              { id: "trust", label: "Trust settings", detail: undefined, current: false },
              { id: "theme", label: "Toggle theme", detail: "dark", current: true },
              { id: "log", label: "View logs", detail: undefined, current: false },
            ]}
            selectedIndex={overlayIndex}
            onNavigate={setOverlayIndex}
            onConfirm={confirm("ActionPicker")}
            onCancel={dismiss}
          />
        );
      case "session":
        return (
          <SessionChooser
            sessions={[
              { id: "s1", preview: "Scaffolded the monorepo and wired up vite", date: "2025-07-10" },
              { id: "s2", preview: "Fixed WebSocket reconnect logic", date: "2025-07-11" },
              { id: "s3", preview: "Added overlay components and DevShell demos", date: "2025-07-12" },
            ]}
            selectedIndex={overlayIndex}
            onNavigate={setOverlayIndex}
            onConfirm={confirm("SessionChooser")}
            onCancel={dismiss}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="app">
      {/* Zone 1: Header */}
      <header className="header">
        <span className="header__wordmark">RAILGUN</span>
        <span style={{ fontSize: 11, color: "var(--color-dim)", marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
          Press 1-7 to show overlays
        </span>
      </header>

      {/* Zone 2: Transcript */}
      <Transcript lines={lines} streaming={streaming} busy={busy} />

      {/* Zone 3: Bottom stack */}
      <div className="bottom-stack">
        <TodoPanel todos={MOCK_TODOS} isLoading={false} />

        <div className="overlay-zone">
          {renderOverlay()}
        </div>

        <Composer
          state={composer}
          mode="idle"
          onSubmit={handleSubmit}
          onAbort={() => { /* no-op in dev */ }}
        />

        <StatusBar
          model="claude-sonnet-4"
          gitStatus={{ branch: "main", dirty: true }}
          cwd="~/Projects/railgun"
          unsaved={false}
          activeMoaPreset={null}
        />
      </div>
    </div>
  );
};
