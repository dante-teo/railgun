import React, { useEffect } from "react";
import type { TrustChoice } from "@railgun/core/trust.js";

interface TrustPickerItem {
  readonly label: string;
  readonly value: TrustChoice;
}

interface TrustPickerProps {
  readonly choices: readonly TrustPickerItem[];
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
}

export const TrustPicker: React.FC<TrustPickerProps> = ({
  choices,
  selectedIndex,
  onSelect,
  onCancel,
}) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelect((selectedIndex + 1) % choices.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onSelect((selectedIndex - 1 + choices.length) % choices.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSelect(selectedIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIndex, choices.length, onSelect, onCancel]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Trust decision">
      <div className="overlay__header">Trust</div>
      <div className="overlay__list" role="listbox">
        {choices.map((choice, i) => (
          <div
            key={choice.value}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(i)}
          >
            {choice.label}
          </div>
        ))}
      </div>
    </div>
  );
};
