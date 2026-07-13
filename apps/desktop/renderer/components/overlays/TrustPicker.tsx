import type React from "react";
import { useEffect, useRef } from "react";
import type { TrustChoice } from "@railgun/core/trust.js";
import { useListKeyboard } from "./useListKeyboard.js";

export interface TrustPickerItem {
  readonly label: string;
  readonly value: TrustChoice;
}

export interface TrustPickerProps {
  readonly choices: readonly TrustPickerItem[];
  readonly selectedIndex: number;
  readonly onNavigate: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onCancel: () => void;
}

export const TrustPicker: React.FC<TrustPickerProps> = ({
  choices,
  selectedIndex,
  onNavigate,
  onConfirm,
  onCancel,
}) => {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useListKeyboard({
    length: choices.length,
    selectedIndex,
    wrap: true,
    onNavigate,
    onConfirm,
    onCancel,
  });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Trust decision">
      <div className="overlay__header">Trust</div>
      <div className="overlay__list" role="listbox">
        {choices.map((choice, i) => (
          <div
            key={choice.value}
            ref={i === selectedIndex ? selectedRef : undefined}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onConfirm(i)}
          >
            {choice.label}
          </div>
        ))}
      </div>
    </div>
  );
};
