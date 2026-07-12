import React from "react";

interface SlashSuggestionsProps {
  readonly matches: readonly string[];
  readonly selectedIndex: number | null;
  readonly onSelect: (command: string) => void;
}

export const SlashSuggestions: React.FC<SlashSuggestionsProps> = ({
  matches,
  selectedIndex,
  onSelect,
}) => {
  if (matches.length === 0) return null;

  return (
    <div className="slash-suggestions" role="listbox" aria-label="Slash command suggestions">
      {matches.map((cmd, i) => (
        <div
          key={cmd}
          className={`slash-suggestions__item${i === selectedIndex ? " slash-suggestions__item--selected" : ""}`}
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(cmd)}
        >
          {cmd}
        </div>
      ))}
    </div>
  );
};
