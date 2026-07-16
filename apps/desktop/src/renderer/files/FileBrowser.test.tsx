// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListing, FilePreview, RailgunDesktopApi } from "../../shared/types";
import { FileBrowser } from "./FileBrowser";

afterEach(cleanup);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe("Files browser", () => {
  it("loads branches lazily, caches them, refreshes explicitly, and retries branch errors", async () => {
    let folderAttempts = 0;
    const listFiles = vi.fn(async (path: readonly string[]) => {
      if (path.length === 0) return { entries: [{ name: "folder", kind: "directory" as const, symlink: false }] };
      folderAttempts += 1;
      if (folderAttempts === 1) throw new Error("Folder went away");
      return { entries: [{ name: "inside.txt", kind: "file" as const, symlink: false }] };
    });
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listFiles, previewFile: vi.fn(), revealFile: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<FileBrowser onCollapse={() => undefined} />);
    const refresh = screen.getByRole("button", { name: "Refresh files" });
    const collapse = screen.getByRole("button", { name: "Collapse Files" });
    expect(refresh.className).toContain("bg-transparent");
    expect(refresh.className).toContain("size-[var(--titlebar-control-height)]");
    expect(refresh.className).toContain("rounded-full");
    expect(refresh.className).not.toContain("size-control-icon");
    expect(collapse.className).toContain("bg-transparent");
    expect(collapse.className).toContain("size-[var(--titlebar-control-height)]");
    expect(collapse.className).toContain("rounded-full");
    expect(collapse.className).not.toContain("size-control-icon");
    expect(refresh.parentElement?.className).not.toContain("[&_button]:min-h-[var(--titlebar-control-height)]");
    fireEvent.click(await screen.findByRole("treeitem", { name: "folder" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Folder went away");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("treeitem", { name: "inside.txt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("treeitem", { name: "folder" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "folder" }));
    expect(listFiles).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(4));
  });

  it("protects against stale previews, renders image/text errors, and reveals selections", async () => {
    const first = deferred<FilePreview>();
    const second = deferred<FilePreview>();
    const previewFile = vi.fn((path: readonly string[]) => path[0] === "first.txt" ? first.promise : second.promise);
    const revealFile = vi.fn(async () => undefined);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listFiles: async () => ({ entries: [
        { name: "first.txt", kind: "file", symlink: false },
        { name: "second.png", kind: "file", symlink: false },
        { name: "broken", kind: "unavailable", symlink: true },
      ] }),
      previewFile,
      revealFile,
    } as unknown as RailgunDesktopApi });
    render(<FileBrowser onCollapse={() => undefined} />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "first.txt" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "second.png" }));
    second.resolve({ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 2, height: 3 });
    expect(await screen.findByRole("img", { name: "second.png" })).toBeTruthy();
    first.resolve({ kind: "text", text: "stale text" });
    await Promise.resolve();
    expect(screen.queryByText("stale text")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    await waitFor(() => expect(revealFile).toHaveBeenCalledWith(["second.png"]));
    fireEvent.click(screen.getByRole("treeitem", { name: "broken" }));
    expect(screen.getByText("This item is unavailable.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reveal in Finder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalidates a pending preview when a folder is selected", async () => {
    const pendingPreview = deferred<FilePreview>();
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listFiles: async (path: readonly string[]) => path.length === 0 ? { entries: [
        { name: "pending.txt", kind: "file", symlink: false },
        { name: "folder", kind: "directory", symlink: false },
      ] } : { entries: [] },
      previewFile: () => pendingPreview.promise,
      revealFile: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<FileBrowser onCollapse={() => undefined} />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "pending.txt" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "folder" }));
    await act(async () => {
      pendingPreview.resolve({ kind: "text", text: "obsolete preview" });
      await pendingPreview.promise;
    });
    expect(screen.queryByText("obsolete preview")).toBeNull();
    expect(screen.getByText("Select a file to preview it.")).toBeTruthy();
  });

  it("does not let an older folder response overwrite an explicit refresh", async () => {
    const initial = deferred<DirectoryListing>();
    const refreshed = deferred<DirectoryListing>();
    let folderRequest = 0;
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listFiles: (path: readonly string[]) => {
        if (path.length === 0) return Promise.resolve({ entries: [{ name: "folder", kind: "directory" as const, symlink: false }] });
        folderRequest += 1;
        return folderRequest === 1 ? initial.promise : refreshed.promise;
      },
      previewFile: vi.fn(),
      revealFile: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<FileBrowser onCollapse={() => undefined} />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    await act(async () => {
      refreshed.resolve({ entries: [{ name: "current.txt", kind: "file", symlink: false }] });
      await refreshed.promise;
    });
    expect(await screen.findByRole("treeitem", { name: "current.txt" })).toBeTruthy();
    await act(async () => {
      initial.resolve({ entries: [{ name: "stale.txt", kind: "file", symlink: false }] });
      await initial.promise;
    });
    expect(screen.queryByRole("treeitem", { name: "stale.txt" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "current.txt" })).toBeTruthy();
  });

  it("supports roving focus and the complete tree keyboard contract", async () => {
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listFiles: async (path: readonly string[]) => path.length === 0 ? { entries: [
        { name: "folder", kind: "directory" as const, symlink: false },
        { name: "last.txt", kind: "file" as const, symlink: false },
      ] } : { entries: [{ name: "inside.txt", kind: "file" as const, symlink: false }] },
      previewFile: async () => ({ kind: "text" as const, text: "preview" }),
      revealFile: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<FileBrowser onCollapse={() => undefined} />);

    const folder = await screen.findByRole("treeitem", { name: "folder" });
    expect(folder.getAttribute("tabindex")).toBe("0");
    folder.focus();
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    const inside = await screen.findByRole("treeitem", { name: "inside.txt" });
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    expect(document.activeElement).toBe(inside);
    expect(folder.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(inside, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "last.txt" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(folder);
    fireEvent.keyDown(folder, { key: "ArrowLeft" });
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(folder);
    fireEvent.keyDown(folder, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(folder);
    const last = screen.getByRole("treeitem", { name: "last.txt" });
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(last);
    folder.focus();
    fireEvent.keyDown(folder, { key: " " });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
  });
});
