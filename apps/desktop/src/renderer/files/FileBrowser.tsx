import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Image as ImageIcon, PanelRightClose, RefreshCw } from "lucide-react";
import type { DirectoryEntry, FilePreview } from "../../shared/types";
import { Button } from "../components/ui/button";
import { errorMessage } from "../lib/utils";

interface FolderState {
  readonly state: "loading" | "ready" | "error";
  readonly entries?: readonly DirectoryEntry[];
  readonly error?: string;
}

interface Selection {
  readonly path: readonly string[];
  readonly kind: DirectoryEntry["kind"];
}

interface VisibleEntry extends Selection { readonly key: string }

const pathKey = (path: readonly string[]): string => JSON.stringify(path);

interface FileBrowserProps {
  readonly onCollapse: () => void;
}

export const FileBrowser = ({ onCollapse }: FileBrowserProps): React.JSX.Element => {
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([pathKey([])]));
  const [selection, setSelection] = useState<Selection>();
  const [preview, setPreview] = useState<FilePreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [revealError, setRevealError] = useState<string>();
  const [focusedKey, setFocusedKey] = useState<string>();
  const previewRequest = useRef(0);
  const folderRequests = useRef(new Map<string, number>());
  const treeItems = useRef(new Map<string, HTMLButtonElement>());

  const loadFolder = async (path: readonly string[], force = false): Promise<void> => {
    const key = pathKey(path);
    if (!force && (folders[key]?.state === "ready" || folders[key]?.state === "loading")) return;
    const request = (folderRequests.current.get(key) ?? 0) + 1;
    folderRequests.current.set(key, request);
    setFolders(current => ({ ...current, [key]: { state: "loading" } }));
    try {
      const listing = await window.railgunDesktop.listFiles(path);
      if (folderRequests.current.get(key) !== request) return;
      setFolders(current => ({ ...current, [key]: { state: "ready", entries: listing.entries } }));
    } catch (error) {
      if (folderRequests.current.get(key) !== request) return;
      setFolders(current => ({ ...current, [key]: { state: "error", error: errorMessage(error, "This folder is unavailable.") } }));
    }
  };

  useEffect(() => { void loadFolder([]); }, []);

  const clearPreview = (): number => {
    const request = ++previewRequest.current;
    setPreview(undefined);
    setPreviewError(undefined);
    setPreviewLoading(false);
    return request;
  };

  const selectEntry = (path: readonly string[], kind: DirectoryEntry["kind"]): void => {
    setSelection({ path, kind });
    setRevealError(undefined);
    const request = clearPreview();
    if (kind !== "file") {
      if (kind === "unavailable") setPreviewError("This item is unavailable.");
      return;
    }
    setPreviewLoading(true);
    void window.railgunDesktop.previewFile(path).then(
      value => { if (previewRequest.current === request) setPreview(value); },
      error => { if (previewRequest.current === request) setPreviewError(errorMessage(error, "Preview unavailable.")); },
    ).finally(() => { if (previewRequest.current === request) setPreviewLoading(false); });
  };

  const toggleFolder = (path: readonly string[]): void => {
    const key = pathKey(path);
    setSelection({ path, kind: "directory" });
    setRevealError(undefined);
    clearPreview();
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (!expanded.has(key)) void loadFolder(path);
  };

  const refresh = (): void => {
    const path = selection === undefined ? [] : selection.kind === "directory" ? selection.path : selection.path.slice(0, -1);
    void loadFolder(path, true);
  };

  const reveal = async (): Promise<void> => {
    if (selection === undefined || selection.kind === "unavailable") return;
    setRevealError(undefined);
    try { await window.railgunDesktop.revealFile(selection.path); }
    catch (error) { setRevealError(errorMessage(error, "Unable to reveal this item.")); }
  };

  const visibleEntries = useMemo((): readonly VisibleEntry[] => {
    const collect = (path: readonly string[]): readonly VisibleEntry[] => {
      const folder = folders[pathKey(path)];
      if (folder?.state !== "ready") return [];
      return folder.entries?.flatMap(entry => {
        const childPath = [...path, entry.name];
        const item = { key: pathKey(childPath), path: childPath, kind: entry.kind };
        return entry.kind === "directory" && expanded.has(item.key) ? [item, ...collect(childPath)] : [item];
      }) ?? [];
    };
    return collect([]);
  }, [expanded, folders]);

  useEffect(() => {
    if (focusedKey !== undefined && visibleEntries.some(entry => entry.key === focusedKey)) return;
    setFocusedKey(visibleEntries[0]?.key);
  }, [focusedKey, visibleEntries]);

  const focusEntry = (key: string | undefined): void => {
    if (key === undefined) return;
    setFocusedKey(key);
    treeItems.current.get(key)?.focus();
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, entry: VisibleEntry): void => {
    const index = visibleEntries.findIndex(item => item.key === entry.key);
    if (event.key === "ArrowDown") focusEntry(visibleEntries[Math.min(index + 1, visibleEntries.length - 1)]?.key);
    else if (event.key === "ArrowUp") focusEntry(visibleEntries[Math.max(index - 1, 0)]?.key);
    else if (event.key === "Home") focusEntry(visibleEntries[0]?.key);
    else if (event.key === "End") focusEntry(visibleEntries.at(-1)?.key);
    else if (event.key === "ArrowRight" && entry.kind === "directory") {
      if (!expanded.has(entry.key)) toggleFolder(entry.path);
      else focusEntry(visibleEntries[index + 1]?.path.length === entry.path.length + 1 ? visibleEntries[index + 1]?.key : undefined);
    } else if (event.key === "ArrowLeft") {
      if (entry.kind === "directory" && expanded.has(entry.key)) toggleFolder(entry.path);
      else if (entry.path.length > 1) focusEntry(pathKey(entry.path.slice(0, -1)));
    } else if (event.key === "Enter" || event.key === " ") {
      entry.kind === "directory" ? toggleFolder(entry.path) : selectEntry(entry.path, entry.kind);
    } else return;
    event.preventDefault();
  };

  const renderFolder = (path: readonly string[], depth: number): React.JSX.Element => {
    const key = pathKey(path);
    const folder = folders[key];
    if (folder?.state === "loading" || folder === undefined) return <li className="flex items-center justify-between gap-1 p-2 text-caption text-foreground-secondary" role="status">Loading…</li>;
    if (folder.state === "error") return <li className="flex items-center justify-between gap-1 p-2 text-caption text-foreground-secondary" role="alert"><span>{folder.error}</span><Button size="sm" variant="ghost" onClick={() => void loadFolder(path, true)}>Retry</Button></li>;
    if (folder.entries?.length === 0) return <li className="flex items-center justify-between gap-1 p-2 text-caption text-foreground-secondary">Empty folder</li>;
    return <>{folder.entries?.map(entry => {
      const childPath = [...path, entry.name];
      const childKey = pathKey(childPath);
      const open = entry.kind === "directory" && expanded.has(childKey);
      const selected = selection !== undefined && pathKey(selection.path) === childKey;
      const visibleEntry = { key: childKey, path: childPath, kind: entry.kind };
      return <li key={entry.name} role="none">
        <button
          ref={element => { if (element === null) treeItems.current.delete(childKey); else treeItems.current.set(childKey, element); }}
          type="button"
          role="treeitem"
          aria-expanded={entry.kind === "directory" ? open : undefined}
          aria-selected={selected}
          aria-level={depth + 1}
          tabIndex={focusedKey === childKey || (focusedKey === undefined && visibleEntries[0]?.key === childKey) ? 0 : -1}
          className={`grid min-h-[1.875rem] w-full grid-cols-[1rem_1rem_minmax(0,1fr)_auto] items-center gap-1 overflow-hidden border-0 bg-transparent py-1 pr-2 text-left text-foreground hover:bg-[var(--color-menu-hover)] [&>svg]:size-3.5 [&>span:nth-last-child(2)]:truncate${selected ? " bg-accent" : ""}${entry.kind === "unavailable" ? " text-foreground-tertiary" : ""}`}
          style={{ paddingInlineStart: `calc(var(--space-2) + ${String(depth)} * var(--space-4))` }}
          onFocus={() => setFocusedKey(childKey)}
          onKeyDown={event => handleTreeKeyDown(event, visibleEntry)}
          onClick={() => entry.kind === "directory" ? toggleFolder(childPath) : selectEntry(childPath, entry.kind)}
        >
          {entry.kind === "directory" ? open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" /> : <span className="w-4" />}
          {entry.kind === "directory" ? open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
          <span>{entry.name}</span>{entry.symlink ? <span className="text-[0.5625rem] uppercase text-foreground-tertiary" aria-hidden="true">link</span> : null}
        </button>
        {open ? <ul className="m-0 list-none p-0" role="group">{renderFolder(childPath, depth + 1)}</ul> : null}
      </li>;
    })}</>;
  };

  return <section className="grid size-full min-w-0 grid-rows-[auto_auto_minmax(0,1fr)]" aria-label="Files browser">
    <header className="relative flex min-h-14 gap-3 border-b border-border px-3 pb-2 pt-[calc(var(--titlebar-control-center-y)_-_0.875rem)]">
      <div><h2 className="m-0 text-[0.9375rem] font-semibold tracking-[-0.01em]">Files</h2><p className="m-0 mt-0.5 text-caption text-foreground-secondary">Home</p></div>
      <div className="absolute right-3 top-[var(--titlebar-control-center-y)] z-[var(--layer-titlebar-control)] flex -translate-y-1/2 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button type="button" variant="ghost" size="titlebarIcon" aria-label="Refresh files" title="Refresh" onClick={refresh}><RefreshCw aria-hidden="true" /></Button>
        <Button className="min-h-[var(--titlebar-control-height)]" type="button" variant="ghost" size="sm" disabled={selection === undefined || selection.kind === "unavailable"} onClick={() => void reveal()}>Reveal in Finder</Button>
        <Button type="button" variant="ghost" size="titlebarIcon" aria-label="Collapse Files" title="Collapse Files" onClick={onCollapse}><PanelRightClose aria-hidden="true" /></Button>
      </div>
    </header>
    {revealError === undefined ? null : <p className="m-0 border-b border-border px-3 py-2 text-caption text-destructive" role="alert">{revealError}</p>}
    <div className="grid min-h-0 grid-cols-[minmax(9rem,34%)_minmax(0,1fr)]">
      <div className="min-w-0 overflow-auto border-r border-border py-2" aria-label="Home folder"><ul className="m-0 list-none p-0" role="tree">{renderFolder([], 0)}</ul></div>
      <div className="min-w-0 overflow-auto bg-background" aria-live="polite">
        {previewLoading ? <p className="m-0 grid min-h-full place-content-center justify-items-center gap-2 p-4 text-center text-foreground-secondary" role="status">Loading preview…</p>
          : previewError !== undefined ? <div className="grid min-h-full place-content-center justify-items-center gap-2 p-4 text-center text-foreground-secondary [&_svg]:size-6 [&_p]:m-0"><File aria-hidden="true" /><p>{previewError}</p></div>
            : preview?.kind === "text" ? <pre className="m-0 min-h-full min-w-full rounded-none bg-transparent p-4 text-caption"><code>{preview.text}</code></pre>
              : preview?.kind === "image" ? <figure className="m-0 grid min-h-full place-items-center content-center gap-3 p-4"><img className="block max-h-[calc(100vh_-_10rem)] max-w-full object-contain" src={preview.dataUrl} alt={selection?.path.at(-1) ?? "Selected image"} /><figcaption className="flex items-center gap-1 text-caption text-foreground-secondary [&_svg]:size-3.5"><ImageIcon aria-hidden="true" />{preview.width} × {preview.height}</figcaption></figure>
                : <div className="grid min-h-full place-content-center justify-items-center gap-2 p-4 text-center text-foreground-secondary [&_svg]:size-6 [&_p]:m-0"><File aria-hidden="true" /><p>Select a file to preview it.</p></div>}
      </div>
    </div>
  </section>;
};
