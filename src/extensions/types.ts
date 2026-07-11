// Discriminated union of lifecycle events
export type ExtensionEvent =
  | ToolCallEvent
  | ToolResultEvent
  | SessionStartEvent
  | SessionShutdownEvent
  | InputEvent;

export type ToolCallEvent = {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
};
export type ToolCallResult = { readonly block?: true; readonly reason?: string };

export type ToolResultEvent = {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: string;
  readonly details?: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
};
export type ToolResultHandlerResult = {
  readonly content?: string;
  readonly details?: unknown;
  readonly isError?: boolean;
};

export type SessionStartEvent = {
  readonly type: "session_start";
  readonly reason: "new" | "resume";
  readonly previousSessionFile?: string;
};

export type SessionShutdownEvent = {
  readonly type: "session_shutdown";
  readonly reason: "exit" | "reset";
  readonly targetSessionFile?: string;
};

export type InputEvent = {
  readonly type: "input";
  readonly text: string;
  readonly images?: readonly string[];
  readonly source: "cli" | "rpc";
};
export type InputHandlerResult = {
  readonly action: "continue" | "transform" | "handled";
  readonly text?: string;
  readonly images?: readonly string[];
};

// Conditional handler return type based on event type
export type ExtensionHandler<E extends ExtensionEvent> =
  E extends ToolCallEvent ? (event: ToolCallEvent) => ToolCallResult | void | Promise<ToolCallResult | void> :
  E extends ToolResultEvent ? (event: ToolResultEvent) => ToolResultHandlerResult | void | Promise<ToolResultHandlerResult | void> :
  E extends InputEvent ? (event: InputEvent) => InputHandlerResult | void | Promise<InputHandlerResult | void> :
  (event: E) => void | Promise<void>;

export interface ExtensionRegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (
    args: Record<string, unknown>,
    ctx: ExtensionContext
  ) => Promise<{ content: string; isError?: boolean }>;
}

export interface ExtensionContext {
  readonly sessionId: string;
}

export interface ExtensionAPI {
  on<E extends ExtensionEvent["type"]>(
    event: E,
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: E }>>
  ): void;
  registerTool(tool: ExtensionRegisteredTool): void;
  // Future surfaces — stubbed now for shape stability:
  registerCommand(name: string, opts: unknown): void;
  registerShortcut(keyId: string, opts: unknown): void;
  registerFlag(name: string, opts: unknown): void;
  registerProvider(name: string, config: unknown): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
export type ExtensionError = { readonly extension: string; readonly event: string; readonly error: unknown };
