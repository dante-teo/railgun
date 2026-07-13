import { describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinModel } from "widevin";
import { DREAM_SYSTEM_PROMPT, formatDreamMessage, runDreamSession } from "./dreamJob.js";
import type { Memory, MemoryStore } from "../persistence/memoryStore.js";

vi.mock("../agent/projectContext.js", () => ({
  loadSoulIdentity: vi.fn(async () => null),
  SOUL_PATH: "/mock/home/.railgun/SOUL.md",
}));

import { loadSoulIdentity } from "../agent/projectContext.js";

const makeMemory = (i: number): Memory => ({
  id: `id-${i}`,
  content: `memory ${i}`,
  category: "fact",
  createdAt: i,
});

const makeMemoryStore = (memories: readonly Memory[]): MemoryStore => {
  const all = vi.fn<MemoryStore["all"]>(() => memories);
  const save = vi.fn<MemoryStore["save"]>((content, category) => ({
    id: "new-id",
    content,
    category,
    createdAt: Date.now() / 1000,
  }));
  const search = vi.fn<MemoryStore["search"]>(() => []);
  const recent = vi.fn<MemoryStore["recent"]>(() => []);
  const deleteMemory = vi.fn<MemoryStore["delete"]>(() => true);
  const update = vi.fn<MemoryStore["update"]>(() => null);
  const runInTransaction = vi.fn<MemoryStore["runInTransaction"]>((fn) => { fn(); });

  return {
    all,
    save,
    search,
    recent,
    delete: deleteMemory,
    update,
    runInTransaction,
  } satisfies MemoryStore;
};

const makeDevinProvider = (streamChat: DevinProvider["streamChat"]): DevinProvider =>
  ({
    login: vi.fn<DevinProvider["login"]>(async () => "token"),
    setToken: vi.fn<DevinProvider["setToken"]>(async () => {}),
    clearToken: vi.fn<DevinProvider["clearToken"]>(async () => {}),
    listModels: vi.fn<DevinProvider["listModels"]>(async () => []),
    streamChat,
  }) satisfies DevinProvider;

const makeModel = (): DevinModel => ({
  id: "test-model",
  name: "Test Model",
  provider: "devin" as const,
  baseUrl: "https://test.devin.dev",
  input: ["text"] as const,
  supportsTools: true as const,
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 8192,
});

// ---------------------------------------------------------------------------
// DREAM_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("DREAM_SYSTEM_PROMPT", () => {
  it("is a non-empty array of strings", () => {
    expect(DREAM_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    for (const block of DREAM_SYSTEM_PROMPT) {
      expect(typeof block).toBe("string");
    }
  });

  it("mentions memory_consolidate tool", () => {
    const joined = DREAM_SYSTEM_PROMPT.join("\n");
    expect(joined).toContain("memory_consolidate");
  });

  it("mentions SOUL.md promotion via write_file", () => {
    const joined = DREAM_SYSTEM_PROMPT.join("\n");
    expect(joined).toContain("SOUL.md");
    expect(joined).toContain("write_file");
  });
});

// ---------------------------------------------------------------------------
// formatDreamMessage
// ---------------------------------------------------------------------------

describe("formatDreamMessage", () => {
  const memories: readonly Memory[] = [
    { id: "a1", content: "prefers terse answers", category: "preference", createdAt: 1 },
    { id: "b2", content: "works in TypeScript", category: "fact", createdAt: 2 },
  ];

  it("includes all memory ids, categories, and content", () => {
    const msg = formatDreamMessage(memories, null);
    expect(msg).toContain("[id:a1]");
    expect(msg).toContain("[preference]");
    expect(msg).toContain("prefers terse answers");
    expect(msg).toContain("[id:b2]");
    expect(msg).toContain("[fact]");
  });

  it("includes memory count in the header", () => {
    const msg = formatDreamMessage(memories, null);
    expect(msg).toContain("2 total");
  });

  it("shows existing SOUL.md content when present", () => {
    const msg = formatDreamMessage(memories, "## Identity\nI prefer terse output.");
    expect(msg).toContain("I prefer terse output.");
  });

  it("shows 'does not exist yet' hint when SOUL.md is absent", () => {
    const msg = formatDreamMessage(memories, null);
    expect(msg).toContain("does not exist yet");
  });
});

// ---------------------------------------------------------------------------
// runDreamSession
// ---------------------------------------------------------------------------

describe("runDreamSession", () => {
  it("logs and returns early when fewer than 5 memories", async () => {
    const store = makeMemoryStore([makeMemory(1), makeMemory(2)]);
    const log = vi.fn();
    const mockDevin = makeDevinProvider(() => (async function* () {})());

    await runDreamSession(store, mockDevin, makeModel(), log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not enough"));
    expect(store.all).toHaveBeenCalled();
  });

  it("loads soul identity and passes it in the user message", async () => {
    vi.mocked(loadSoulIdentity).mockResolvedValueOnce("## Identity\nI like brevity.");
    const memories = Array.from({ length: 5 }, (_, i) => makeMemory(i + 1));
    const store = makeMemoryStore(memories);
    const log = vi.fn();
    const streamChat = vi.fn<DevinProvider["streamChat"]>(() => (async function* () {})());

    await runDreamSession(store, makeDevinProvider(streamChat), makeModel(), log);

    expect(loadSoulIdentity).toHaveBeenCalled();
    const firstCall = streamChat.mock.calls[0]?.[0];
    const userText = (firstCall?.messages ?? [])
      .filter(m => m.role === "user")
      .map(m => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(userText).toContain("I like brevity.");
  });

  it("calls agent.run when enough memories exist", async () => {
    vi.mocked(loadSoulIdentity).mockResolvedValueOnce(null);
    const memories = Array.from({ length: 5 }, (_, i) => makeMemory(i + 1));
    const store = makeMemoryStore(memories);
    const log = vi.fn();
    const streamChat = vi.fn<DevinProvider["streamChat"]>(() => (async function* () {})());

    await runDreamSession(store, makeDevinProvider(streamChat), makeModel(), log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reviewing 5 memories"));
    expect(streamChat).toHaveBeenCalled();
  });
});
