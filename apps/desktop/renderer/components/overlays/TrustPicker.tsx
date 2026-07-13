import React from "react";
import type { TrustChoice } from "@railgun/core/trust.js";
import { useOverlayKeyNav } from "../../hooks/useOverlayKeyNav.js";

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
  useOverlayKeyNav({ length: choices.length, selectedIndex, onSelect, onCancel, wrap: true });

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
