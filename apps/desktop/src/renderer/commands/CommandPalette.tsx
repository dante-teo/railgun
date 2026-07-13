import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import type { RendererCommand } from "./commandRegistry";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly RendererCommand[];
  readonly restoreFocusTo: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
}

const nextEnabledIndex = (
  commands: readonly RendererCommand[],
  current: number,
  direction: 1 | -1,
): number => {
  if (commands.length === 0) return -1;
  for (let offset = 1; offset <= commands.length; offset += 1) {
    const index = (current + (offset * direction) + commands.length) % commands.length;
    if (commands[index]?.enabled === true) return index;
  }
  return -1;
};

export const CommandPalette = ({ open, commands, restoreFocusTo, onOpenChange }: CommandPaletteProps): React.JSX.Element => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? commands
      : commands.filter((command) => command.label.toLocaleLowerCase().includes(normalized));
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(nextEnabledIndex(filtered, -1, 1));
  }, [filtered, open]);

  const execute = (command: RendererCommand | undefined): void => {
    if (command?.enabled !== true) return;
    onOpenChange(false);
    command.execute();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="command-palette"
        showClose={false}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocusTo?.focus(); }}
      >
        <DialogHeader className="command-palette-header">
          <DialogTitle>Command Palette</DialogTitle>
          <DialogDescription>Search available Railgun commands.</DialogDescription>
        </DialogHeader>
        <label className="command-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label="Search commands"
            placeholder="Type a command…"
            value={query}
            aria-controls="command-list"
            aria-activedescendant={activeIndex < 0 ? undefined : `command-${filtered[activeIndex]?.id}`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => nextEnabledIndex(filtered, current, event.key === "ArrowDown" ? 1 : -1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(filtered[activeIndex]);
              }
            }}
          />
        </label>
        <div id="command-list" className="command-list" role="listbox" aria-label="Commands">
          {filtered.map((command, index) => (
            <button
              id={`command-${command.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={!command.enabled}
              disabled={!command.enabled}
              className={index === activeIndex ? "active" : ""}
              key={command.id}
              onMouseMove={() => { if (command.enabled) setActiveIndex(index); }}
              onClick={() => execute(command)}
            >
              <span>{command.label}</span>{command.shortcut === undefined ? null : <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 ? <p className="command-empty">No matching commands</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
