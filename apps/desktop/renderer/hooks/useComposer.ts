import { useState } from "react";
import { findMatches, nextCompletionState } from "@railgun/core/commands.js";

export interface ComposerState {
  readonly draft: string;
  readonly completionIndex: number | null;
  readonly completionMatches: readonly string[];
  readonly composerRevision: number;
  readonly liveMatches: readonly string[];
  readonly setDraft: (value: string) => void;
  readonly handleTab: () => void;
  readonly handleEscape: () => void;
  readonly handleCtrlU: () => void;
  readonly handleSubmit: (onSubmit: (text: string) => void) => void;
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
    // Clear frozen completion when draft changes externally
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

  return {
    draft,
    completionIndex,
    completionMatches,
    composerRevision,
    liveMatches,
    setDraft,
    handleTab,
    handleEscape,
    handleCtrlU,
    handleSubmit,
  };
};
