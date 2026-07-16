// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstructionFileSummary, KnowledgeDesktopApi, RailgunDesktopApi } from "../../shared/types";
import { KnowledgePage } from "./KnowledgePage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const instructionFiles: readonly InstructionFileSummary[] = [
  { id: "soul", label: "~/.railgun/SOUL.md", status: "active" },
  { id: "railgun-dotfile", label: "~/.railgun.md", status: "active" },
  { id: "railgun", label: "~/RAILGUN.md", status: "missing" },
  { id: "agents-upper", label: "~/AGENTS.md", status: "shadowed" },
  { id: "agents-lower", label: "~/agents.md", status: "missing" },
  { id: "claude-upper", label: "~/CLAUDE.md", status: "missing" },
  { id: "claude-lower", label: "~/claude.md", status: "missing" },
  { id: "cursor-rules", label: "~/.cursorrules", status: "missing" },
];
const api = (): KnowledgeDesktopApi => ({
  listMemories: async () => Array.from({ length: 5 }, (_, index) => ({ id: `m-${index}`, content: `memory ${index}`, category: "fact", createdAt: index })),
  createMemory: async value => ({ id: "new", ...value, createdAt: 1 }),
  updateMemory: async (id, value) => ({ id, ...value, createdAt: 1 }), deleteMemory: async () => undefined,
  importNotes: async () => ({ cancelled: false, imported: 2 }), searchNotes: async () => [],
  runDream: async () => ({ status: "completed", beforeCount: 5, afterCount: 4 }), onDreamProgress: () => () => undefined,
  listInstructionFiles: async () => instructionFiles,
  getInstructionFile: async id => ({ ...instructionFiles.find(file => file.id === id)!, content: "Original" }),
  updateInstructionFile: async (id, content) => ({ ...instructionFiles.find(file => file.id === id)!, content }),
});

describe("Knowledge page", () => {
  it("embeds a controlled destination without tabs or standalone navigation", async () => {
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { ...api(), listSkills: async () => [], getSkill: vi.fn() } as unknown as RailgunDesktopApi });
    render(<KnowledgePage embedded destination="skills" />);
    expect(screen.queryByRole("button", { name: "Back to Railgun" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Knowledge destinations" })).toBeNull();
    expect(await screen.findByText("No skills installed")).toBeTruthy();
  });

  it("does not render an empty Notes results group", async () => {
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api() });
    const { container } = render(<KnowledgePage embedded destination="notes" />);

    expect(container.querySelector("ul")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No note chunks matched.")).toBeTruthy();
    expect(container.querySelector("ul")).toBeNull();
  });

  it("shows Dream eligibility from the full memory list", async () => {
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api() });
    render(<KnowledgePage onBack={() => undefined} onDirtyChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Memories/u }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Dream" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), { target: { value: "narrow" } });
    expect(screen.getByRole("button", { name: "Run Dream" }).hasAttribute("disabled")).toBe(false);
  });

  it("refreshes Dream eligibility after a filtered memory mutation", async () => {
    const desktop = api();
    let count = 5;
    desktop.listMemories = async query => Array.from(
      { length: query ? Math.min(1, count) : count },
      (_, index) => ({ id: `m-${index}`, content: `memory ${index}`, category: "fact", createdAt: index }),
    );
    desktop.deleteMemory = async () => { count -= 1; };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: desktop });
    render(<KnowledgePage onBack={() => undefined} onDirtyChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Memories/u }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Dream" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), { target: { value: "memory" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete this memory?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Memory" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Dream" }).hasAttribute("disabled")).toBe(true));
  });

  it("serializes memory deletion and keeps failures in the confirmation", async () => {
    const desktop = api();
    let rejectDelete!: (error: Error) => void;
    const deleteMemory = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectDelete = reject; }))
      .mockResolvedValueOnce(undefined);
    desktop.deleteMemory = deleteMemory;
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: desktop });
    render(<KnowledgePage embedded destination="memories" />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(5));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    const confirm = screen.getByRole("button", { name: "Delete Memory" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(deleteMemory).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => rejectDelete(new Error("delete failed")));
    expect((await screen.findByRole("alert")).textContent).toContain("delete failed");
    fireEvent.click(screen.getByRole("button", { name: "Delete Memory" }));
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledTimes(2));
  });

  it("guards dirty instruction navigation and saves empty Markdown", async () => {
    const desktop = api(); const update = vi.spyOn(desktop, "updateInstructionFile");
    const onBack = vi.fn();
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: desktop });
    render(<KnowledgePage onBack={onBack} onDirtyChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Instructions/u }));
    const editor = await screen.findByRole("textbox", { name: "Markdown instructions" });
    fireEvent.change(editor, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to Railgun" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Notes/u }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("soul", ""));
  });

  it("shows a completed empty state when no instruction files exist", async () => {
    const desktop = api();
    desktop.listInstructionFiles = async () => [];
    const getInstructionFile = vi.spyOn(desktop, "getInstructionFile");
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: desktop });

    render(<KnowledgePage embedded destination="instructions" />);

    expect(await screen.findByRole("heading", { name: "No instruction files available" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Loading instructions…" })).toBeNull();
    expect(getInstructionFile).not.toHaveBeenCalled();
  });

  it("retries a failed selected instruction-file request", async () => {
    const desktop = api();
    const getFile = vi.spyOn(desktop, "getInstructionFile")
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockImplementation(async id => ({ ...instructionFiles.find(file => file.id === id)!, content: "Recovered" }));
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: desktop });
    render(<KnowledgePage onBack={() => undefined} onDirtyChange={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: /Instructions/u }));
    expect((await screen.findByRole("alert")).textContent).toContain("temporary read failure");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect((await screen.findByRole("textbox", { name: "Markdown instructions" }) as HTMLTextAreaElement).value).toBe("Recovered");
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("filters skills, renders sanitized detail, and exposes invocation status", async () => {
    const listSkills = vi.fn(async () => [
      { name: "testing", description: "Test desktop flows", disableModelInvocation: false },
      { name: "release", description: "Review a release", disableModelInvocation: true },
    ]);
    const getSkill = vi.fn(async (name: string) => ({
      name,
      description: name === "release" ? "Review a release" : "Test desktop flows",
      disableModelInvocation: name === "release",
      body: `# ${name}\n\n<script>unsafe()</script>Safe body`,
    }));
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { ...api(), listSkills, getSkill, openExternal: vi.fn() } as unknown as RailgunDesktopApi });
    render(<KnowledgePage onBack={vi.fn()} />);
    expect(await screen.findByText("Available to model")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "release" } });
    expect(screen.queryByRole("button", { name: /testing/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /release/u }));
    expect(await screen.findByText("Model invocation disabled")).toBeTruthy();
    await waitFor(() => expect(getSkill).toHaveBeenLastCalledWith("release"));
  });

  it("shows skill list loading, empty, error, and retry states", async () => {
    const listSkills = vi.fn().mockRejectedValueOnce(new Error("store offline")).mockResolvedValueOnce([]);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { ...api(), listSkills, getSkill: vi.fn(), openExternal: vi.fn() } as unknown as RailgunDesktopApi });
    render(<KnowledgePage onBack={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading skills");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No skills installed")).toBeTruthy();
  });
});
