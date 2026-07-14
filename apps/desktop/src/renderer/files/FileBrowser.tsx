import { useEffect, useRef, useState } from "react";
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
  const previewRequest = useRef(0);
  const folderRequests = useRef(new Map<string, number>());

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

  const renderFolder = (path: readonly string[], depth: number): React.JSX.Element => {
    const key = pathKey(path);
    const folder = folders[key];
    if (folder?.state === "loading" || folder === undefined) return <li className="file-tree-state" role="status">Loading…</li>;
    if (folder.state === "error") return <li className="file-tree-state" role="alert"><span>{folder.error}</span><Button size="sm" variant="ghost" onClick={() => void loadFolder(path, true)}>Retry</Button></li>;
    if (folder.entries?.length === 0) return <li className="file-tree-state">Empty folder</li>;
    return <>{folder.entries?.map(entry => {
      const childPath = [...path, entry.name];
      const childKey = pathKey(childPath);
      const open = entry.kind === "directory" && expanded.has(childKey);
      const selected = selection !== undefined && pathKey(selection.path) === childKey;
      return <li key={entry.name} role="treeitem" aria-expanded={entry.kind === "directory" ? open : undefined}>
        <button
          type="button"
          className={`file-tree-row${selected ? " selected" : ""}${entry.kind === "unavailable" ? " unavailable" : ""}`}
          style={{ paddingInlineStart: `calc(var(--space-2) + ${String(depth)} * var(--space-4))` }}
          onClick={() => entry.kind === "directory" ? toggleFolder(childPath) : selectEntry(childPath, entry.kind)}
        >
          {entry.kind === "directory" ? open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" /> : <span className="file-tree-chevron" />}
          {entry.kind === "directory" ? open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
          <span>{entry.name}</span>{entry.symlink ? <span className="symlink-badge" aria-hidden="true">link</span> : null}
        </button>
        {open ? <ul role="group">{renderFolder(childPath, depth + 1)}</ul> : null}
      </li>;
    })}</>;
  };

  return <section className="files-browser" aria-label="Files browser">
    <header className="files-header">
      <div><h2>Files</h2><p>Home</p></div>
      <div className="files-header-actions">
        <Button type="button" variant="sidebarIcon" size="icon" aria-label="Refresh files" title="Refresh" onClick={refresh}><RefreshCw aria-hidden="true" /></Button>
        <Button type="button" variant="sidebarIcon" size="sm" disabled={selection === undefined || selection.kind === "unavailable"} onClick={() => void reveal()}>Reveal in Finder</Button>
        <Button type="button" variant="sidebarIcon" size="icon" aria-label="Collapse Files" title="Collapse Files" onClick={onCollapse}><PanelRightClose aria-hidden="true" /></Button>
      </div>
    </header>
    {revealError === undefined ? null : <p className="files-action-error" role="alert">{revealError}</p>}
    <div className="files-split">
      <div className="file-tree" aria-label="Home folder"><ul role="tree">{renderFolder([], 0)}</ul></div>
      <div className="file-preview" aria-live="polite">
        {previewLoading ? <p role="status">Loading preview…</p>
          : previewError !== undefined ? <div className="file-preview-message"><File aria-hidden="true" /><p>{previewError}</p></div>
            : preview?.kind === "text" ? <pre><code>{preview.text}</code></pre>
              : preview?.kind === "image" ? <figure><img src={preview.dataUrl} alt={selection?.path.at(-1) ?? "Selected image"} /><figcaption><ImageIcon aria-hidden="true" />{preview.width} × {preview.height}</figcaption></figure>
                : <div className="file-preview-message"><File aria-hidden="true" /><p>Select a file to preview it.</p></div>}
      </div>
    </div>
  </section>;
};
