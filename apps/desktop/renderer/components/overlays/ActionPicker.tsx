import React, { useEffect, useRef } from "react";
import { useListKeyboard } from "./useListKeyboard.js";

export interface ActionPickerItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly current?: boolean;
}

export interface ActionPickerProps {
  readonly title: string;
  readonly items: readonly ActionPickerItem[];
  readonly selectedIndex: number;
  readonly onNavigate: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onCancel: () => void;
}

export const ActionPicker: React.FC<ActionPickerProps> = ({
  title,
  items,
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
    length: items.length,
    selectedIndex,
    onNavigate,
    onConfirm,
    onCancel,
  });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="overlay__header">{title}</div>
      <div className="overlay__list" role="listbox">
        {items.map((item, i) => (
          <div
            key={item.id}
            ref={i === selectedIndex ? selectedRef : undefined}
            className={[
              "overlay__item",
              i === selectedIndex ? "overlay__item--selected" : "",
              item.current ? "overlay__item--current" : "",
            ].filter(Boolean).join(" ")}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onConfirm(i)}
          >
            <span>{item.label}</span>
            {item.detail !== undefined && (
              <span className="overlay__item__detail">{item.detail}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
