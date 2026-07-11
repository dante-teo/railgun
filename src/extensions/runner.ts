import type {
  ExtensionEvent,
  ExtensionHandler,
  ExtensionRegisteredTool,
  ExtensionError,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultHandlerResult,
  InputEvent,
  InputHandlerResult,
  SessionStartEvent,
  SessionShutdownEvent,
} from "./types.js";

type AnyHandler = ExtensionHandler<ExtensionEvent>;

interface HandlerEntry {
  readonly handler: AnyHandler;
  readonly source: string;
}

export interface ExtensionRunner {
  on<E extends ExtensionEvent["type"]>(
    event: E,
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: E }>>,
    source: string
  ): void;
  registerTool(tool: ExtensionRegisteredTool): void;
  onExtensionError(listener: (err: ExtensionError) => void): void;
  reportExtensionError(err: ExtensionError): void;
  emitToolCall(event: ToolCallEvent): Promise<ToolCallResult>;
  emitToolResult(event: ToolResultEvent): Promise<ToolResultHandlerResult>;
  emitInput(event: InputEvent): Promise<InputHandlerResult>;
  emitSessionStart(event: SessionStartEvent): Promise<void>;
  emitSessionShutdown(event: SessionShutdownEvent): Promise<void>;
  getTools(): ExtensionRegisteredTool[];
}

export const createExtensionRunner = (): ExtensionRunner => {
  const handlerMap = new Map<string, HandlerEntry[]>();
  const tools: ExtensionRegisteredTool[] = [];
  const errorListeners: Array<(err: ExtensionError) => void> = [];

  const reportExtensionError = (err: ExtensionError): void => {
    for (const listener of errorListeners) {
      try { listener(err); } catch { /* ignore listener errors */ }
    }
  };

  const on = <E extends ExtensionEvent["type"]>(
    event: E,
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: E }>>,
    source: string
  ): void => {
    const list = handlerMap.get(event) ?? [];
    list.push({ handler: handler as AnyHandler, source });
    handlerMap.set(event, list);
  };

  const registerTool = (tool: ExtensionRegisteredTool): void => {
    tools.push(tool);
  };

  const onExtensionError = (listener: (err: ExtensionError) => void): void => {
    errorListeners.push(listener);
  };

  // emitToolCall: fail-closed — no try/catch, throws propagate to the agent loop
  const emitToolCall = async (event: ToolCallEvent): Promise<ToolCallResult> => {
    for (const { handler } of handlerMap.get("tool_call") ?? []) {
      const result = await (handler as ExtensionHandler<ToolCallEvent>)(event);
      if (result && result.block) return result;
    }
    return {};
  };

  // emitToolResult: observer — catch per handler, merge overrides
  const emitToolResult = async (event: ToolResultEvent): Promise<ToolResultHandlerResult> => {
    let acc: ToolResultHandlerResult = {};
    for (const { handler, source } of handlerMap.get("tool_result") ?? []) {
      try {
        const result = await (handler as ExtensionHandler<ToolResultEvent>)(event);
        if (result) {
          acc = {
            ...acc,
            ...(result.content !== undefined ? { content: result.content } : {}),
            ...(result.details !== undefined ? { details: result.details } : {}),
            ...(result.isError !== undefined ? { isError: result.isError } : {}),
          };
        }
      } catch (error) {
        reportExtensionError({ extension: source, event: "tool_result", error });
      }
    }
    return acc;
  };

  // emitInput: supports transform/handled with per-handler error isolation
  const emitInput = async (event: InputEvent): Promise<InputHandlerResult> => {
    let current = event;
    for (const { handler, source } of handlerMap.get("input") ?? []) {
      try {
        const result = await (handler as ExtensionHandler<InputEvent>)(current);
        if (result) {
          if (result.action === "handled") return result;
          if (result.action === "transform") {
            current = {
              type: "input",
              source: current.source,
              text: result.text ?? current.text,
              ...(result.images !== undefined ? { images: result.images } : current.images !== undefined ? { images: current.images } : {}),
            };
          }
        }
      } catch (error) {
        reportExtensionError({ extension: source, event: "input", error });
      }
    }
    return { action: "continue", text: current.text, ...(current.images !== undefined ? { images: current.images } : {}) };
  };

  // shared observer loop for session lifecycle events
  const emitObserver = async (
    eventType: "session_start" | "session_shutdown",
    event: SessionStartEvent | SessionShutdownEvent
  ): Promise<void> => {
    for (const { handler, source } of handlerMap.get(eventType) ?? []) {
      try {
        await (handler as (e: typeof event) => void | Promise<void>)(event);
      } catch (error) {
        reportExtensionError({ extension: source, event: eventType, error });
      }
    }
  };

  const emitSessionStart = (event: SessionStartEvent): Promise<void> =>
    emitObserver("session_start", event);

  const emitSessionShutdown = (event: SessionShutdownEvent): Promise<void> =>
    emitObserver("session_shutdown", event);

  return {
    on,
    registerTool,
    onExtensionError,
    reportExtensionError,
    emitToolCall,
    emitToolResult,
    emitInput,
    emitSessionStart,
    emitSessionShutdown,
    getTools: () => [...tools],
  };
};
