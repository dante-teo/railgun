import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { PaletteContent, PaletteHeader, PaletteList, PaletteOption, PaletteSearch, PaletteState } from "../components/palette";
import { useListboxNavigation } from "../components/use-listbox-navigation";
import type { RendererCommand } from "./commandRegistry";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly RendererCommand[];
  readonly restoreFocusTo: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
}

export const CommandPalette = ({ open, commands, restoreFocusTo, onOpenChange }: CommandPaletteProps): React.JSX.Element => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? commands
      : commands.filter((command) => command.label.toLocaleLowerCase().includes(normalized));
  }, [commands, query]);

  const execute = (command: RendererCommand | undefined): void => {
    if (command?.enabled !== true) return;
    onOpenChange(false);
    command.execute();
  };
  const navigation = useListboxNavigation({ open, items: filtered, getItemKey: command => command.id, isItemDisabled: command => !command.enabled, onActivate: execute });
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <PaletteContent
        showClose={false}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocusTo?.focus(); }}
      >
        <PaletteHeader title="Command Palette" description="Search available Railgun Classic commands." />
          <PaletteSearch
            ref={inputRef}
            aria-label="Search commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            placeholder="Type a command…"
            value={query}
            aria-controls="command-list"
            aria-activedescendant={navigation.activeIndex < 0 ? undefined : `command-${filtered[navigation.activeIndex]?.id}`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={navigation.onKeyDown}
          />
        <PaletteList id="command-list" role="listbox" aria-label="Commands">
          {filtered.map((command, index) => (
            <PaletteOption
              id={`command-${command.id}`}
              type="button"
              role="option"
              aria-selected={index === navigation.activeIndex}
              aria-disabled={!command.enabled}
              disabled={!command.enabled}
              active={index === navigation.activeIndex}
              key={command.id}
              onMouseMove={() => { if (command.enabled) navigation.setActiveIndex(index); }}
              onClick={() => execute(command)}
            >
              <span>{command.label}</span>{command.shortcut === undefined ? null : <kbd>{command.shortcut}</kbd>}
            </PaletteOption>
          ))}
        </PaletteList>
        {filtered.length === 0 ? <PaletteState>No matching commands</PaletteState> : null}
      </PaletteContent>
    </Dialog>
  );
};
