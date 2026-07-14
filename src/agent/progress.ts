export interface ProgressToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

interface CallProgress {
  readonly repeatedResults: number;
  readonly lastResult: string | null;
}

const IDEMPOTENT_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  web_search: true,
  web_fetch: true,
  read_file: true,
  list_directory: true,
  note_search: true,
  note_search_semantic: true,
});

const isIdempotent = (toolName: string): boolean => IDEMPOTENT_TOOLS[toolName] === true;
const callProgress = (repeatedResults: number, lastResult: string | null): CallProgress =>
  Object.freeze({ repeatedResults, lastResult });

export interface ProgressState {
  readonly consecutiveSearches: number;
  readonly calls: Readonly<Record<string, CallProgress>>;
}

export interface ToolCallDecision {
  readonly call: ProgressToolCall;
  readonly key: string;
  readonly allowed: boolean;
  readonly guidance?: string;
}

const stableValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stableValue)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
      : value;

const callKey = (call: ProgressToolCall): string => `${call.name}:${JSON.stringify(stableValue(call.arguments))}`;

export const initialProgressState = (): ProgressState => Object.freeze({ consecutiveSearches: 0, calls: Object.freeze({}) });

export const planToolCalls = (
  state: ProgressState,
  calls: readonly ProgressToolCall[],
  cron: boolean,
): { readonly state: ProgressState; readonly decisions: readonly ToolCallDecision[] } => {
  const reduced = calls.reduce(({ current, decisions }, call) => {
    const key = callKey(call);
    const previous = current.calls[key];
    const researchClosed = cron && call.name === "web_search" && current.consecutiveSearches >= 10;
    const repeatedBlocked = isIdempotent(call.name) && (previous?.repeatedResults ?? 0) >= 5;
    const allowed = !researchClosed && !repeatedBlocked;
    const consecutiveSearches = allowed
      ? call.name === "web_search" ? current.consecutiveSearches + 1 : 0
      : current.consecutiveSearches;
    const guidance = researchClosed
      ? "Research is closed after 10 consecutive searches. Use existing evidence, fetch known sources, and deliver the requested artifact."
      : repeatedBlocked
        ? "Blocked this identical non-progressing call after repeated attempts. Change approach and finish the requested work."
        : call.name === "web_search" && consecutiveSearches === 6
          ? "Search is no longer adding enough value. Fetch promising results, synthesize the evidence, and complete the requested artifact."
          : undefined;
    const nextCalls = allowed
      ? { ...current.calls, [key]: callProgress(previous?.repeatedResults ?? 0, previous?.lastResult ?? null) }
      : current.calls;
    return {
      current: Object.freeze({ consecutiveSearches, calls: Object.freeze(nextCalls) }),
      decisions: [...decisions, { call, key, allowed, ...(guidance ? { guidance } : {}) }],
    };
  }, { current: state, decisions: [] as ToolCallDecision[] });
  return { state: reduced.current, decisions: reduced.decisions };
};

export const recordToolResults = (
  state: ProgressState,
  decisions: readonly ToolCallDecision[],
  results: readonly { readonly content: string; readonly isError: boolean }[],
): { readonly state: ProgressState; readonly guidance?: string } => {
  const allowed = decisions.filter(decision => decision.allowed);
  const reduced = allowed.reduce<{ readonly calls: Record<string, CallProgress>; readonly warn: boolean }>((progress, decision, index) => {
    const previous = progress.calls[decision.key] ?? state.calls[decision.key]!;
    const result = results[index];
    if (!result || !isIdempotent(decision.call.name)) return progress;
    const fingerprint = JSON.stringify([result.isError, result.content]);
    const repeatedResults = previous.lastResult === fingerprint ? previous.repeatedResults + 1 : 1;
    return {
      calls: { ...progress.calls, [decision.key]: callProgress(repeatedResults, fingerprint) },
      warn: progress.warn || repeatedResults === 2,
    };
  }, { calls: { ...state.calls }, warn: false });
  return {
    state: Object.freeze({ ...state, calls: Object.freeze(reduced.calls) }),
    ...(reduced.warn ? { guidance: "This identical idempotent call is repeating the same result. Change approach or use the evidence already collected." } : {}),
  };
};
