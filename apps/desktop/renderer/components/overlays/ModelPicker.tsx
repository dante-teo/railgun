import React, { useEffect } from "react";
import type { DevinModel } from "widevin";

interface ModelPickerProps {
  readonly models: readonly DevinModel[];
  readonly selectedIndex: number;
  readonly sessionOnly: boolean;
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  models,
  selectedIndex,
  sessionOnly,
  onSelect,
  onCancel,
}) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelect(Math.min(selectedIndex + 1, models.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onSelect(Math.max(selectedIndex - 1, 0));
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
  }, [selectedIndex, models.length, onSelect, onCancel]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Select model">
      <div className="overlay__header">
        {sessionOnly ? "Model (session only)" : "Model"}
      </div>
      <div className="overlay__list" role="listbox">
        {models.map((model, i) => (
          <div
            key={model.id}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(i)}
          >
            <span>{model.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
