import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { SessionSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { filterSessions } from "./filterSessions";

interface TaskPaletteProps {
  readonly open: boolean;
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId: string | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly restoreFocusTo: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
  readonly onSelect: (sessionId: string) => void;
}

export const TaskPalette = ({
  open,
  sessions,
  activeSessionId,
  loading,
  error,
  disabled,
  restoreFocusTo,
  onOpenChange,
  onRetry,
  onSelect,
}: TaskPaletteProps): React.JSX.Element => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterSessions(sessions, query), [query, sessions]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(filtered.length === 0 || disabled ? -1 : 0);
  }, [disabled, filtered, open]);

  const select = (session: SessionSummary | undefined): void => {
    if (session === undefined || disabled) return;
    onOpenChange(false);
    onSelect(session.id);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className="command-palette task-palette"
      showClose={false}
      onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocusTo?.focus(); }}
    >
      <DialogHeader className="command-palette-header">
        <DialogTitle>Find a Task</DialogTitle>
        <DialogDescription>Search and resume a previous task.</DialogDescription>
      </DialogHeader>
      <label className="command-search">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={query}
          aria-controls="task-search-results"
          aria-activedescendant={activeIndex < 0 ? undefined : `task-option-${String(activeIndex)}`}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && filtered.length > 0 && !disabled) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex(current => (current + direction + filtered.length) % filtered.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              select(filtered[activeIndex]);
            }
          }}
        />
      </label>
      <div id="task-search-results" className="command-list task-search-results" role="listbox" aria-label="Previous tasks">
        {loading ? <p className="command-empty" role="status">Loading tasks…</p>
          : error !== undefined ? <div className="task-search-error" role="alert"><p>{error}</p><Button size="sm" variant="tonal" onClick={onRetry}>Retry</Button></div>
            : sessions.length === 0 ? <p className="command-empty">No saved tasks</p>
              : filtered.length === 0 ? <p className="command-empty">No matching tasks</p>
                : filtered.map((session, index) => <button
                  id={`task-option-${String(index)}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "active" : ""}
                  disabled={disabled}
                  key={session.id}
                  onMouseMove={() => { if (!disabled) setActiveIndex(index); }}
                  onClick={() => select(session)}
                >
                  <span><strong>{session.firstUserPreview || "Untitled task"}</strong><small>{session.model} · {session.startedAtLocal}</small></span>
                  {session.id === activeSessionId ? <small>Current</small> : null}
                </button>)}
      </div>
    </DialogContent>
  </Dialog>;
};
