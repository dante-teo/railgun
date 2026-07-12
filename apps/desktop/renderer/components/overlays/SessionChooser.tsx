import React, { useEffect } from "react";

interface SessionEntry {
  readonly id: string;
  readonly preview: string;
  readonly date: string;
}

interface SessionChooserProps {
  readonly sessions: readonly SessionEntry[];
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
}

export const SessionChooser: React.FC<SessionChooserProps> = ({
  sessions,
  selectedIndex,
  onSelect,
  onCancel,
}) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelect((selectedIndex + 1) % sessions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onSelect((selectedIndex - 1 + sessions.length) % sessions.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSelect(selectedIndex);
      } else if (e.key === "Escape" || (e.key === "c" && e.ctrlKey)) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIndex, sessions.length, onSelect, onCancel]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Resume session">
      <div className="overlay__header">Sessions</div>
      <div className="overlay__list" role="listbox">
        {sessions.map((session, i) => (
          <div
            key={session.id}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(i)}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {session.preview}
            </span>
            <span style={{ color: "var(--color-dim)", fontSize: 11, fontFamily: "var(--font-mono)", marginLeft: "var(--spacing-sm)" }}>
              {session.date}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
