import React, { useEffect, useRef } from "react";
import type { ComposerState } from "../hooks/useComposer.js";
import { SlashSuggestions } from "./SlashSuggestions.js";

type ComposerMode = "idle" | "busy" | "awaiting_approval" | "steering";

interface ComposerProps {
  readonly state: ComposerState;
  readonly mode: ComposerMode;
  readonly onSubmit: (text: string) => void;
  readonly onAbort: () => void;
}

const PLACEHOLDER: Record<ComposerMode, string> = {
  idle: "Message Railgun…",
  busy: "Steer the active run…",
  awaiting_approval: "Awaiting approval…",
  steering: "Steer the active run…",
};

// Maximum textarea rows (matches TUI cap)
const MAX_ROWS = 6;

export const Composer: React.FC<ComposerProps> = ({ state, mode, onSubmit, onAbort }) => {
  const { draft, setDraft, liveMatches, completionIndex, completionMatches, handleTab, handleEscape, handleCtrlU, handleSubmit } = state;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "24");
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  const isDisabled = mode === "awaiting_approval";

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Tab") {
      e.preventDefault();
      handleTab();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleEscape();
      return;
    }
    if (e.key === "u" && e.ctrlKey) {
      e.preventDefault();
      handleCtrlU();
      return;
    }
    if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      onAbort();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(onSubmit);
      return;
    }
  };

  const activeSuggestions = completionMatches.length > 1
    ? completionMatches
    : liveMatches.length > 1 ? liveMatches : [];

  return (
    <div className="composer" role="search" aria-label="Message input">
      <SlashSuggestions
        matches={activeSuggestions}
        selectedIndex={completionIndex}
        onSelect={(cmd) => { setDraft(cmd + " "); }}
      />
      <span className="composer__prompt" aria-hidden="true">❯</span>
      <textarea
        ref={textareaRef}
        className="composer__textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={PLACEHOLDER[mode]}
        disabled={isDisabled}
        rows={1}
        aria-label="Message input"
        aria-multiline="true"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
};
