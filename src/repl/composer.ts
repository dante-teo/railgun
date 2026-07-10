export type ComposerAction =
  | { readonly type: "submit" }
  | { readonly type: "newline" }
  | { readonly type: "complete" }
  | { readonly type: "enqueue-placeholder" }
  | { readonly type: "input" };

interface ComposerKey {
  readonly return: boolean;
  readonly shift: boolean;
  readonly tab: boolean;
}

export const interpretComposerKey = (key: ComposerKey, hasCompletion: boolean): ComposerAction =>
  key.tab ? { type: hasCompletion ? "complete" : "enqueue-placeholder" }
    : key.return ? { type: key.shift ? "newline" : "submit" }
    : { type: "input" };

const wrappedLineRows = (line: string, width: number): number =>
  Math.max(1, Math.ceil(line.length / Math.max(1, width)));

export const composerMaxRows = (terminalHeight: number): number =>
  Math.max(1, Math.min(6, Math.floor((Math.max(1, terminalHeight) - 6) / 2)));

export const composerRows = (value: string, width: number, terminalHeight: number): number => {
  const contentWidth = Math.max(1, width - 4);
  const desired = value.split("\n").reduce((rows, line) => rows + wrappedLineRows(line, contentWidth), 0);
  return Math.max(1, Math.min(composerMaxRows(terminalHeight), desired));
};

export const preserveDraft = (draft: string, next: string, enabled: boolean): string => enabled ? next : draft;

export const shouldHandleComposerEvent = (eventType: "press" | "repeat" | "release" | undefined): boolean =>
  eventType !== "release";

export const enhancedKeyboardMode = (environment: Readonly<Record<string, string | undefined>>): "enabled" | "disabled" => {
  const term = environment["TERM"] ?? "";
  const program = (environment["TERM_PROGRAM"] ?? "").toLowerCase();
  return environment["KITTY_WINDOW_ID"] !== undefined
    || term === "xterm-kitty"
    || program === "wezterm"
    || program === "ghostty"
    ? "enabled"
    : "disabled";
};

const TERMINAL_CONTROL_REPLIES = [
  /(?:\u001b)?\[\?2031;\d\$y/g,
  /(?:\u001b)?\[\?997;[12]n/g,
  /(?:\u001b)?\]11;rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\u0007|\u001b\\)?/gi,
  /(?:\u001b)?\[\?\d+u/g,
  /(?:\u001b)?\[<\d+;\d+;\d+[Mm]/g,
] as const;

export const sanitizeComposerInput = (input: string): string =>
  TERMINAL_CONTROL_REPLIES.reduce((text, pattern) => text.replace(pattern, ""), input);

export const replaceComposerDraft = (
  currentDraft: string,
  replacement: string | null,
  revision: number,
): { readonly draft: string; readonly revision: number } =>
  replacement === null ? { draft: currentDraft, revision } : { draft: replacement, revision: revision + 1 };
