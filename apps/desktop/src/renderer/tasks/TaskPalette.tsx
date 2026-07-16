import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { PaletteContent, PaletteHeader, PaletteList, PaletteOption, PaletteSearch, PaletteState } from "../components/palette";
import { useListboxNavigation } from "../components/use-listbox-navigation";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterSessions(sessions, query), [query, sessions]);
  const optionsAvailable = !loading && error === undefined && sessions.length > 0;

  const select = (session: SessionSummary | undefined): void => {
    if (session === undefined || disabled) return;
    onOpenChange(false);
    onSelect(session.id);
  };
  const navigation = useListboxNavigation({ open, items: filtered, disabled: disabled || !optionsAvailable, getItemKey: session => session.id, onActivate: select });
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <PaletteContent
      showClose={false}
      onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocusTo?.focus(); }}
    >
      <PaletteHeader title="Find a Task" description="Search and resume a previous task." />
        <PaletteSearch
          ref={inputRef}
          aria-label="Search tasks"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          placeholder="Search tasks…"
          value={query}
          aria-controls="task-search-results"
          aria-activedescendant={!optionsAvailable || navigation.activeIndex < 0 ? undefined : `task-option-${String(navigation.activeIndex)}`}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={navigation.onKeyDown}
        />
      <PaletteList id="task-search-results" role="listbox" aria-label="Previous tasks" aria-busy={loading}>
        {optionsAvailable && filtered.map((session, index) => <PaletteOption
                  id={`task-option-${String(index)}`}
                  type="button"
                  role="option"
                  aria-selected={index === navigation.activeIndex}
                  active={index === navigation.activeIndex}
                  disabled={disabled}
                  key={session.id}
                  onMouseMove={() => { if (!disabled) navigation.setActiveIndex(index); }}
                  onClick={() => select(session)}
                >
                  <span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{session.firstUserPreview || "Untitled task"}</strong><small className="truncate text-caption text-foreground-secondary">{session.model} · {session.startedAtLocal}</small></span>
                  {session.id === activeSessionId ? <small className="text-caption text-foreground-secondary">Current</small> : null}
                </PaletteOption>)}
      </PaletteList>
      {loading ? <PaletteState role="status">Loading tasks…</PaletteState>
        : error !== undefined ? <div className="m-5 grid justify-items-center gap-3 text-center text-foreground-secondary" role="alert"><p className="m-0">{error}</p><Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button></div>
          : sessions.length === 0 ? <PaletteState>No saved tasks</PaletteState>
            : filtered.length === 0 ? <PaletteState>No matching tasks</PaletteState>
              : null}
    </PaletteContent>
  </Dialog>;
};
