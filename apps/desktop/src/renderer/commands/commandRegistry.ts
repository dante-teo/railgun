import type { AppCommand } from "../../shared/types";

export interface RendererCommand {
  readonly id: AppCommand;
  readonly label: string;
  readonly shortcut?: string;
  readonly enabled: boolean;
  readonly execute: () => void;
}

export interface CommandActions {
  readonly newChat: () => void;
  readonly showChat: () => void;
  readonly showSettings: () => void;
  readonly toggleSidebar: () => void;
  readonly retryBackend: () => void;
  readonly stopResponse: () => void;
  readonly canRetryBackend: boolean;
  readonly responseRunning: boolean;
}

type KeyboardShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;
export type ShortcutPlatform = "macos" | "other";

const currentShortcutPlatform = (): ShortcutPlatform =>
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "macos" : "other";

export const commandFromKeyboardEvent = (
  event: KeyboardShortcutEvent,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): AppCommand | undefined => {
  const key = event.key.toLocaleLowerCase();
  if (event.altKey || event.shiftKey) return undefined;
  if (platform === "macos") {
    if (event.metaKey && event.ctrlKey && key === "s") return "toggle-sidebar";
    if (!event.metaKey || event.ctrlKey) return undefined;
  } else {
    if (!event.ctrlKey || event.metaKey) return undefined;
    if (key === "s") return "toggle-sidebar";
  }
  if (key === "n") return "new-chat";
  if (key === "k") return "command-palette";
  if (key === "1") return "show-chat";
  if (key === ",") return "show-settings";
  return undefined;
};

export const createCommandRegistry = (actions: CommandActions): readonly RendererCommand[] => [
  { id: "new-chat", label: "New Chat", shortcut: "⌘N", enabled: true, execute: actions.newChat },
  { id: "show-chat", label: "Chat", shortcut: "⌘1", enabled: true, execute: actions.showChat },
  { id: "show-settings", label: "Settings", shortcut: "⌘,", enabled: true, execute: actions.showSettings },
  { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌃⌘S", enabled: true, execute: actions.toggleSidebar },
  { id: "retry-backend", label: "Retry Backend", enabled: actions.canRetryBackend, execute: actions.retryBackend },
  { id: "stop-response", label: "Stop Response", enabled: actions.responseRunning, execute: actions.stopResponse },
];
