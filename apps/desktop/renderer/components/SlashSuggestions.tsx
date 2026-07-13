import React, { useEffect, useRef } from "react";

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
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (matches.length === 0) return null;

  return (
    <div className="slash-suggestions" role="listbox" aria-label="Slash command suggestions">
      {matches.map((cmd, i) => (
        <div
          key={cmd}
          ref={i === selectedIndex ? selectedRef : undefined}
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
