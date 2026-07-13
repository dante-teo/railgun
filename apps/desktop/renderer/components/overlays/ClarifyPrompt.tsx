import React, { useEffect, useRef, useState } from "react";

interface ClarifyPromptProps {
  readonly question: string;
  readonly choices?: readonly string[];
  readonly onAnswer: (answer: string) => void;
  readonly onDismiss: () => void;
}

const MAX_CHOICES = 4;

export const ClarifyPrompt: React.FC<ClarifyPromptProps> = ({
  question,
  choices,
  onAnswer,
  onDismiss,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [freeText, setFreeText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedChoices = choices?.slice(0, MAX_CHOICES);
  const hasChoices = trimmedChoices !== undefined && trimmedChoices.length > 0;

  useEffect(() => {
    if (!hasChoices) inputRef.current?.focus();
  }, [hasChoices]);

  useEffect(() => {
    if (!hasChoices) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, (trimmedChoices?.length ?? 1) - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const answer = trimmedChoices?.[selectedIndex] ?? "";
        onAnswer(answer);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasChoices, selectedIndex, trimmedChoices, onAnswer, onDismiss]);

  return (
    <div className="overlay clarify-overlay" role="dialog" aria-modal="true" aria-label="Clarification needed">
      <div className="clarify-overlay__title">❓ Clarification needed</div>
      <div className="clarify-overlay__question">{question}</div>

      {hasChoices ? (
        <div className="overlay__list" role="listbox">
          {trimmedChoices!.map((choice, i) => (
            <div
              key={choice}
              className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
              role="option"
              aria-selected={i === selectedIndex}
              onClick={() => onAnswer(choice)}
            >
              {choice}
            </div>
          ))}
        </div>
      ) : (
        <div className="clarify-overlay__free-text-row">
          <input
            ref={inputRef}
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); onAnswer(freeText); }
              if (e.key === "Escape") { e.preventDefault(); onDismiss(); }
            }}
            className="clarify-overlay__input"
            aria-label="Your answer"
          />
        </div>
      )}
      <div className="clarify-overlay__hint">
        {hasChoices ? "↑↓ navigate · Enter confirm · Escape dismiss" : "Enter submit · Escape dismiss"}
      </div>
    </div>
  );
};
