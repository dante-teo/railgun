import React, { useEffect, useRef } from "react";
import { useListKeyboard } from "./useListKeyboard.js";

export interface SessionEntry {
  readonly id: string;
  readonly preview: string;
  readonly date: string;
}

export interface SessionChooserProps {
  readonly sessions: readonly SessionEntry[];
  readonly selectedIndex: number;
  readonly onNavigate: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onCancel: () => void;
}

export const SessionChooser: React.FC<SessionChooserProps> = ({
  sessions,
  selectedIndex,
  onNavigate,
  onConfirm,
  onCancel,
}) => {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Escape is handled by useListKeyboard; Ctrl+C is an additional cancel binding.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "c" && e.ctrlKey) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  useListKeyboard({
    length: sessions.length,
    selectedIndex,
    wrap: true,
    onNavigate,
    onConfirm,
    onCancel,
  });

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Resume session">
      <div className="overlay__header">Sessions</div>
      <div className="overlay__list" role="listbox">
        {sessions.map((session, i) => (
          <div
            key={session.id}
            ref={i === selectedIndex ? selectedRef : undefined}
            className={`overlay__item${i === selectedIndex ? " overlay__item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onConfirm(i)}
          >
            <span className="session-item__preview">{session.preview}</span>
            <span className="session-item__date">{session.date}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
