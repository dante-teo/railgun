import React, { useEffect } from "react";

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
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelect(Math.min(selectedIndex + 1, items.length - 1));
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
  }, [selectedIndex, items.length, onSelect, onCancel]);

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
              <span style={{ marginLeft: "auto", color: "var(--color-dim)", fontSize: 12 }}>
                {item.detail}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
