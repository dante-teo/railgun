import React, { useState } from "react";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import type { TodoState } from "@railgun/core/tools/todo.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { TodoPanel } from "./TodoPanel.js";
import { StatusBar } from "./StatusBar.js";
import { useComposer } from "../hooks/useComposer.js";

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

export const DevShell: React.FC = () => {
  const [lines, setLines] = useState<DisplayLine[]>([...MOCK_LINES]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const composer = useComposer();

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

  return (
    <div className="app">
      {/* Zone 1: Header */}
      <header className="header">
        <span className="header__wordmark">RAILGUN</span>
      </header>

      {/* Zone 2: Transcript */}
      <Transcript lines={lines} streaming={streaming} busy={busy} />

      {/* Zone 3: Bottom stack */}
      <div className="bottom-stack">
        <TodoPanel todos={MOCK_TODOS} isLoading={false} />

        <div className="overlay-zone">
          {/* Overlays mount here in production; dev: none active */}
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
