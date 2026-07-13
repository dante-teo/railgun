import type React from "react";
import { glyphs } from "../lib/theme.js";

export type ToolCallState = "running" | "done" | "error";

interface ToolCallLineProps {
  readonly label: string;
  readonly state: ToolCallState;
}

const GLYPH: Record<ToolCallState, string> = {
  running: glyphs.toolRunning,
  done: glyphs.toolDone,
  error: glyphs.toolError,
};

export const ToolCallLine: React.FC<ToolCallLineProps> = ({ label, state }) => (
  <div className={`tool-call tool-call--${state}`} role="status">
    <span className="tool-call__glyph" aria-hidden="true">{GLYPH[state]}</span>
    <span className="tool-call__label">{label}</span>
  </div>
);
