import { useState } from "react";
import { findMatches, nextCompletionState } from "@railgun/core/commands.js";

export interface ComposerState {
  readonly draft: string;
  readonly completionIndex: number | null;
  readonly completionMatches: readonly string[];
  readonly liveMatches: readonly string[];
  readonly composerRevision: number;
  readonly setDraft: (value: string) => void;
  readonly handleTab: () => void;
  readonly handleEscape: () => void;
  readonly handleCtrlU: () => void;
  readonly handleSubmit: (onSubmit: (text: string) => void) => void;
  readonly handleArrowUp: () => void;
  readonly handleArrowDown: () => void;
}

export const useComposer = (): ComposerState => {
  const [draft, setDraftRaw] = useState("");
  const [completionIndex, setCompletionIndex] = useState<number | null>(null);
  const [completionMatches, setCompletionMatches] = useState<readonly string[]>([]);
  const [composerRevision, setComposerRevision] = useState(0);

  const liveMatches: readonly string[] =
    draft.startsWith("/") && !draft.includes(" ") ? findMatches(draft) : [];

  const setDraft = (value: string): void => {
    setDraftRaw(value);
    // Reset completion state; use setDraftRaw internally to bypass this.
    setCompletionIndex(null);
    setCompletionMatches([]);
  };

  const handleTab = (): void => {
    const next = nextCompletionState(completionMatches, completionIndex, liveMatches, "tab");
    setCompletionIndex(next.index);
    setCompletionMatches(next.frozenMatches);
    if (next.input !== null) setDraftRaw(next.input);
  };

  const handleEscape = (): void => {
    if (completionIndex !== null || completionMatches.length > 0) {
      setCompletionIndex(null);
      setCompletionMatches([]);
      return;
    }
    setDraftRaw("");
  };

  const handleCtrlU = (): void => {
    setDraftRaw("");
    setCompletionIndex(null);
    setCompletionMatches([]);
    setComposerRevision(r => r + 1);
  };

  const handleSubmit = (onSubmit: (text: string) => void): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    onSubmit(text);
    setDraftRaw("");
    setCompletionIndex(null);
    setCompletionMatches([]);
  };

  const getActiveSuggestions = (): readonly string[] =>
    completionMatches.length > 1 ? completionMatches
      : liveMatches.length > 1 ? liveMatches : [];

  // Freeze live matches into completionMatches (if not already frozen) and
  // move the selection index by `delta`, wrapping around the list.
  const navigateArrow = (delta: 1 | -1): void => {
    const suggestions = getActiveSuggestions();
    if (suggestions.length === 0) return;
    if (completionMatches.length === 0 && liveMatches.length > 1) {
      setCompletionMatches([...liveMatches]);
    }
    setCompletionIndex(prev => {
      const n = suggestions.length;
      if (prev === null) return delta === 1 ? 0 : n - 1;
      return (prev + delta + n) % n;
    });
  };

  const handleArrowUp = (): void => navigateArrow(-1);
  const handleArrowDown = (): void => navigateArrow(1);

  return {
    draft,
    completionIndex,
    completionMatches,
    liveMatches,
    composerRevision,
    setDraft,
    handleTab,
    handleEscape,
    handleCtrlU,
    handleSubmit,
    handleArrowUp,
    handleArrowDown,
  };
};
