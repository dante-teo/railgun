import type { DevinProvider, DevinModel } from "widevin";
import type { Memory, MemoryStore } from "../persistence/memoryStore.js";
import { createAgent } from "../agent/agent.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { loadSoulIdentity, SOUL_PATH } from "../agent/projectContext.js";

export const DREAM_SYSTEM_PROMPT: readonly string[] = [
  "You are Railgun's memory curator. Your job is to consolidate stored memories and promote stable preferences into the agent's persistent identity file (SOUL.md).",
  [
    "## Phase 1 — Consolidate memories",
    "",
    "For each memory, evaluate:",
    "1. Is it a duplicate or near-duplicate of another memory? → merge them",
    "2. Does it contradict a more recent memory? → delete the older/stale one",
    "3. Is it vague or could be more precisely worded? → update it",
    "4. Is it still relevant? → keep or delete",
    "",
    "Rules:",
    "- Never delete user preferences unless explicitly contradicted by a newer preference",
    "- Merge facts about the same topic into one comprehensive memory",
    "- Preserve the user's exact wording for preferences; consolidate facts freely",
    "- After consolidation, the total memory count should be lower or equal",
    "- Every action must have a reason",
    "",
    "Use the memory_consolidate tool to execute your consolidation plan.",
  ].join("\n"),
  [
    "## Phase 2 — Promote preferences to SOUL.md",
    "",
    "After consolidating, review the remaining 'preference' memories. Promote a preference to SOUL.md if:",
    "- It describes how the user wants the agent to behave (tone, style, approach)",
    "- It is stable and identity-level, not tied to a single session or task",
    "- It is NOT already captured in the current SOUL.md content shown to you",
    "",
    "For each preference that qualifies:",
    `1. Write the updated SOUL.md to ${SOUL_PATH} using write_file, appending to existing content (do not erase unrelated sections)`,
    `2. Delete the promoted memory from the store using memory_consolidate (action: "delete") — it now lives in SOUL.md and no longer needs to be in the database`,
    "",
    "Only write SOUL.md if you have something meaningful to add. Do not rewrite it just to reformat.",
    "If SOUL.md does not exist yet and you have preferences to promote, create it with clean Markdown.",
  ].join("\n"),
];

export const formatDreamMessage = (memories: readonly Memory[], soulContent: string | null): string => {
  const memLines = memories.map((m, i) => `${i + 1}. [id:${m.id}] [${m.category}] ${m.content}`);
  const soulSection = soulContent
    ? `## Current SOUL.md\n\n${soulContent}`
    : `## Current SOUL.md\n\n(file does not exist yet — create it at ${SOUL_PATH} if you have preferences to promote)`;
  return [
    `## Memories to review (${memories.length} total)\n\n${memLines.join("\n")}`,
    soulSection,
  ].join("\n\n");
};

export const runDreamSession = async (
  memoryStore: MemoryStore,
  devin: DevinProvider,
  model: DevinModel,
  log: (msg: string) => void = console.error,
): Promise<void> => {
  const memories = memoryStore.all();
  if (memories.length < 5) {
    log(`Dream: only ${memories.length} memories — not enough to consolidate (minimum 5)`);
    return;
  }

  log(`Dream: reviewing ${memories.length} memories...`);

  const soulContent = await loadSoulIdentity();

  const agent = createAgent({
    devin,
    model: model.id,
    contextWindow: 100_000,
    systemPrompt: DREAM_SYSTEM_PROMPT,
    confirmShellCommand: async () => false,
    iterationBudget: () => IterationBudget.create(30),
    memoryStore,
    enabledToolsets: ["dream", "file"],
  });

  agent.subscribe(event => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName === "memory_consolidate") log("Dream: consolidating memories...");
    if (event.toolName === "write_file") log("Dream: promoting preferences to SOUL.md...");
  });

  await agent.run(formatDreamMessage(memories, soulContent));
  log("Dream: complete.");
};
