import type React from "react";
import { useEffect, useRef } from "react";
import type { DevinModel } from "widevin";
import { useListKeyboard } from "./useListKeyboard.js";

export interface ModelPickerProps {
  readonly models: readonly DevinModel[];
  readonly selectedIndex: number;
  readonly sessionOnly: boolean;
  readonly onNavigate: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onCancel: () => void;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  models,
  selectedIndex,
  sessionOnly,
  onNavigate,
  onConfirm,
  onCancel,
}) => {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useListKeyboard({
    length: models.length,
    selectedIndex,
    onNavigate,
    onConfirm,
    onCancel,
  });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Select model">
      <div className="overlay__header">
        {sessionOnly ? "Model (session only)" : "Model"}
      </div>
      <div className="overlay__list" role="listbox">
        {models.map((model, i) => (
          <div
            key={model.id}
            ref={i === selectedIndex ? selectedRef : undefined}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onConfirm(i)}
          >
            <span>{model.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
