import React, { useEffect } from "react";
import { useOverlayKeyNav } from "../../hooks/useOverlayKeyNav.js";

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
  useOverlayKeyNav({ length: sessions.length, selectedIndex, onSelect, onCancel, wrap: true });

  // Ctrl+C also cancels the session chooser (matches TUI convention)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "c" && e.ctrlKey) { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

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
            <span className="session-item__preview">{session.preview}</span>
            <span className="session-item__date">{session.date}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
