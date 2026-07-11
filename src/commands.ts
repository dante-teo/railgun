export const KNOWN_COMMANDS = ["/exit", "/help", "/clear", "/model", "/compact", "/rollback"] as const;

export const matchCommand = (partial: string): string | undefined => {
  const hits = KNOWN_COMMANDS.filter((c) => c.startsWith(partial));
  return hits.length === 1 ? hits[0] : undefined;
};

export const findMatches = (partial: string): string[] =>
  KNOWN_COMMANDS.filter((c) => c.startsWith(partial));

export const parseSlashCommand = (
  text: string,
): { command: string; arg?: string } => {
  const parts = text.split(" ");
  const command = parts[0] ?? "";
  const arg = parts.slice(1).join(" ").trim();
  return { command, ...(arg ? { arg } : {}) };
};

export interface CompletionState {
  readonly frozenMatches: readonly string[];
  readonly index: number | null;
  readonly input: string | null;
}

const EMPTY_COMPLETION: CompletionState = { frozenMatches: [], index: null, input: null };

export const nextCompletionState = (
  frozen: readonly string[],
  index: number | null,
  liveMatches: readonly string[],
  event: "tab" | "escape",
): CompletionState => {
  if (event === "escape") {
    return EMPTY_COMPLETION;
  }
  if (frozen.length > 1) {
    const next = ((index ?? -1) + 1) % frozen.length;
    return { frozenMatches: frozen, index: next, input: frozen[next] ?? null };
  }
  if (liveMatches.length === 1) {
    return { frozenMatches: [], index: null, input: (liveMatches[0] ?? "") + " " };
  }
  if (liveMatches.length > 1) {
    return { frozenMatches: [...liveMatches], index: null, input: null };
  }
  return EMPTY_COMPLETION;
};
