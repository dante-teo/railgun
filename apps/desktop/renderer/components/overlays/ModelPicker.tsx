import React from "react";
import type { DevinModel } from "widevin";
import { useOverlayKeyNav } from "../../hooks/useOverlayKeyNav.js";

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
  useOverlayKeyNav({ length: models.length, selectedIndex, onSelect, onCancel });

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
