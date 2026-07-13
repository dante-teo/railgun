import React from "react";
import { useOverlayKeyNav } from "../../hooks/useOverlayKeyNav.js";

interface ActionPickerItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly current?: boolean;
}

interface ActionPickerProps {
  readonly title: string;
  readonly items: readonly ActionPickerItem[];
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
}

export const ActionPicker: React.FC<ActionPickerProps> = ({
  title,
  items,
  selectedIndex,
  onSelect,
  onCancel,
}) => {
  useOverlayKeyNav({ length: items.length, selectedIndex, onSelect, onCancel });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="overlay__header">{title}</div>
      <div className="overlay__list" role="listbox">
        {items.map((item, i) => (
          <div
            key={item.id}
            className={[
              "overlay__item",
              i === selectedIndex ? "overlay__item--selected" : "",
              item.current ? "overlay__item--current" : "",
            ].filter(Boolean).join(" ")}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(i)}
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
