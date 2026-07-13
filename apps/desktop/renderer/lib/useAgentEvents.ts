import { useEffect, useReducer, useRef, useCallback } from "react";
import type { DevinModel } from "widevin";
import { parseSlashCommand } from "@railgun/core/commands.js";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import { shouldAppendToolTranscriptLine, shouldShowToolLine } from "@railgun/core/repl/toolLineStyle.js";
import type { StreamSegments } from "@railgun/core/repl/streamingTranscript.js";
import {
  createStreamSegments,
  appendStreamDelta,
  flushStreamSegment,
  finishStreamSegments,
} from "@railgun/core/repl/streamingTranscript.js";
import { buildToolLabel } from "@railgun/core/tools/toolLabel.js";
import { parseAdvisoryMessage } from "@railgun/core/advisor/advisoryMessage.js";
import type { TodoState } from "@railgun/core/tools/todo.js";
import type { GatewayEvent } from "../../gateway/protocol.js";
import type { ConnectionStatus, GatewayClient } from "./gatewayClient.js";
import { createGatewayClient, nextCmdId } from "./gatewayClient.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComposerMode = "idle" | "busy" | "awaiting_approval" | "steering";

export interface OverlayState {
  readonly kind: "model" | "trust" | "clarify" | "approval" | "action" | "session";
  readonly selectedIndex: number;
}

export interface ShellState {
  // Transcript
  readonly lines: readonly DisplayLine[];
  readonly streaming: string;
  readonly busy: boolean;
  readonly queuedSteer: boolean;
  readonly toolLabels: ReadonlyMap<string, string>;
  // Todos
  readonly todos: TodoState;
  readonly todoLoading: boolean;
  // Session metadata
  readonly model: string;
  readonly cwd: string;
  readonly gitStatus: { branch: string | null; dirty: boolean };
  // UI state
  readonly overlay: OverlayState | null;
  readonly composerMode: ComposerMode;
  readonly connected: ConnectionStatus;
  // Overlay-specific data
  readonly pendingCommand: string | null;
  readonly pendingClarify: { readonly question: string; readonly choices?: readonly string[] } | null;
  readonly availableModels: readonly DevinModel[];
  readonly activeMoaPreset: { name: string } | null;
  // Actions
  readonly submit: (text: string) => void;
  readonly abort: () => void;
  readonly approveCommand: (approved: boolean) => void;
  readonly answerClarify: (answer: string) => void;
  readonly setModel: (modelId: string) => void;
  readonly setOverlay: (overlay: OverlayState | null) => void;
  readonly navigateOverlay: (index: number) => void;
  readonly clearLines: () => void;
}

// ---------------------------------------------------------------------------
// Internal reducer
// ---------------------------------------------------------------------------

interface ReducerState {
  readonly lines: readonly DisplayLine[];
  readonly streaming: string;
  readonly busy: boolean;
  readonly queuedSteer: boolean;
  readonly toolLabels: ReadonlyMap<string, string>;
  readonly todos: TodoState;
  readonly todoLoading: boolean;
  readonly model: string;
  readonly overlay: OverlayState | null;
  readonly composerMode: ComposerMode;
  readonly connected: ConnectionStatus;
  readonly pendingCommand: string | null;
  readonly pendingClarify: { readonly question: string; readonly choices?: readonly string[] } | null;
  readonly availableModels: readonly DevinModel[];
}

type ReducerAction =
  | { readonly type: "set_connected"; readonly status: ConnectionStatus }
  | { readonly type: "streaming_delta"; readonly segment: string }
  | { readonly type: "flush_streaming"; readonly line: string | null }
  | { readonly type: "tool_start"; readonly toolCallId: string; readonly label: string; readonly isTodo: boolean }
  | { readonly type: "tool_end"; readonly toolCallId: string; readonly toolName: string; readonly isError: boolean; readonly label: string }
  | { readonly type: "append_line"; readonly line: DisplayLine }
  | { readonly type: "update_last_moa_ref"; readonly index: number; readonly model: string; readonly summary: string }
  | { readonly type: "state_update"; readonly busy: boolean; readonly model: string; readonly todos: TodoState }
  | { readonly type: "run_complete"; readonly finalSegment: string }
  | { readonly type: "approval_request"; readonly command: string }
  | { readonly type: "clarify_request"; readonly question: string; readonly choices?: readonly string[] }
  | { readonly type: "approve_done" }
  | { readonly type: "clarify_done" }
  | { readonly type: "set_overlay"; readonly overlay: OverlayState | null }
  | { readonly type: "navigate_overlay"; readonly index: number }
  | { readonly type: "set_model_optimistic"; readonly modelId: string }
  | { readonly type: "set_models"; readonly models: readonly DevinModel[] }
  | { readonly type: "clear_lines" }
  | { readonly type: "abort_done" }
  | { readonly type: "mark_queued_steer" }
  | { readonly type: "reset_streaming" };

const EMPTY_TOOL_LABELS: ReadonlyMap<string, string> = new Map();

const initialState: ReducerState = {
  lines: [],
  streaming: "",
  busy: false,
  queuedSteer: false,
  toolLabels: EMPTY_TOOL_LABELS,
  todos: [],
  todoLoading: false,
  model: "unknown",
  overlay: null,
  composerMode: "idle",
  connected: "connecting",
  pendingCommand: null,
  pendingClarify: null,
  availableModels: [],
};

const reduce = (state: ReducerState, action: ReducerAction): ReducerState => {
  switch (action.type) {
    case "set_connected":
      return { ...state, connected: action.status };

    case "streaming_delta":
      return { ...state, streaming: action.segment };

    case "flush_streaming": {
      if (action.line === null) return { ...state, streaming: "" };
      return {
        ...state,
        streaming: "",
        lines: [...state.lines, { kind: "assistant", text: action.line }],
      };
    }

    case "tool_start": {
      const next = new Map(state.toolLabels);
      next.set(action.toolCallId, action.label);
      return {
        ...state,
        toolLabels: next,
        todoLoading: action.isTodo ? true : state.todoLoading,
      };
    }

    case "tool_end": {
      const next = new Map(state.toolLabels);
      next.delete(action.toolCallId);
      const isTodoTool = !shouldAppendToolTranscriptLine(action.toolName);
      const showLine = shouldShowToolLine(action.toolName, action.isError);
      const newLines = showLine
        ? [...state.lines, { kind: "tool" as const, text: action.label, failed: action.isError }]
        : state.lines;
      return {
        ...state,
        toolLabels: next,
        todoLoading: isTodoTool ? false : state.todoLoading,
        lines: newLines,
      };
    }

    case "append_line":
      return { ...state, lines: [...state.lines, action.line] };

    case "update_last_moa_ref": {
      const lines = [...state.lines];
      const last = lines.at(-1);
      const prefix = `⟐ MoA reference ${action.index}/`;
      if (last !== undefined && last.kind === "assistant" && last.text.startsWith(prefix)) {
        lines[lines.length - 1] = {
          kind: "assistant",
          text: `⟐ MoA reference ${action.index} (${action.model}): ${action.summary}`,
        };
      }
      return { ...state, lines };
    }

    case "state_update": {
      const wasBusy = state.busy;
      const nowBusy = action.busy;
      const composerMode: ComposerMode =
        nowBusy
          ? (state.composerMode === "idle" ? "busy" : state.composerMode)
          : "idle";
      return {
        ...state,
        busy: nowBusy,
        model: action.model,
        todos: action.todos,
        composerMode,
        todoLoading: nowBusy ? state.todoLoading : false,
        queuedSteer: wasBusy && !nowBusy ? false : state.queuedSteer,
      };
    }

    case "run_complete": {
      const newLines = action.finalSegment !== ""
        ? [...state.lines, { kind: "assistant" as const, text: action.finalSegment }]
        : state.lines;
      return {
        ...state,
        streaming: "",
        toolLabels: EMPTY_TOOL_LABELS,
        todoLoading: false,
        queuedSteer: false,
        composerMode: "idle",
        lines: newLines,
      };
    }

    case "approval_request":
      return {
        ...state,
        pendingCommand: action.command,
        overlay: { kind: "approval", selectedIndex: 0 },
        composerMode: "awaiting_approval",
      };

    case "clarify_request":
      return {
        ...state,
        pendingClarify: { question: action.question, choices: action.choices },
        overlay: { kind: "clarify", selectedIndex: 0 },
      };

    case "approve_done":
      return {
        ...state,
        pendingCommand: null,
        overlay: null,
        composerMode: "busy",
      };

    case "clarify_done":
      return { ...state, pendingClarify: null, overlay: null };

    case "set_overlay":
      return { ...state, overlay: action.overlay };

    case "navigate_overlay":
      return state.overlay !== null
        ? { ...state, overlay: { ...state.overlay, selectedIndex: action.index } }
        : state;

    case "set_model_optimistic":
      return { ...state, model: action.modelId };

    case "set_models":
      return { ...state, availableModels: action.models };

    case "clear_lines":
      return { ...state, lines: [], streaming: "" };

    case "abort_done":
      return {
        ...state,
        pendingCommand: null,
        pendingClarify: null,
        overlay: null,
        composerMode: "idle",
        lines: [...state.lines, { kind: "error", text: "Stopped by user." }],
      };

    case "mark_queued_steer":
      return { ...state, queuedSteer: true, composerMode: "steering" };

    case "reset_streaming":
      return { ...state, streaming: "", toolLabels: EMPTY_TOOL_LABELS };
  }
};

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `**Available commands:**
- \`/help\` — show this message
- \`/clear\` — clear transcript
- \`/model\` — switch AI model
- \`/compact\` — compact conversation context
- \`/settings\` — open settings
- \`/moa\` — MoA presets (not yet available in desktop)
- \`/trust\` — trust settings (not yet available in desktop)
- \`/branch\` — branch session (not yet available in desktop)
- \`/fork\` — fork session (not yet available in desktop)
- \`/rollback\` — rollback (not yet available in desktop)
- \`/exit\` — exit (not yet available in desktop)
- \`/dream\` — dream (not yet available in desktop)
- \`/cron\` — cron jobs (not yet available in desktop)`;

// Exported so App.tsx can pass this to ActionPicker without re-importing ActionPickerItem
export const SETTINGS_ITEMS = [
  { id: "theme", label: "Toggle theme", detail: "dark", current: false },
] as const;

// ---------------------------------------------------------------------------
// Network response type guards (GatewayResponse.data is `unknown`)
// ---------------------------------------------------------------------------

const isStateData = (v: unknown): v is { running: boolean; model: string; todos: TodoState } =>
  typeof v === "object" && v !== null &&
  "running" in v && typeof (v as Record<string, unknown>)["running"] === "boolean" &&
  "model" in v && typeof (v as Record<string, unknown>)["model"] === "string" &&
  "todos" in v && Array.isArray((v as Record<string, unknown>)["todos"]);

const isModelArray = (v: unknown): v is readonly DevinModel[] =>
  Array.isArray(v) && (v.length === 0 || (typeof v[0] === "object" && v[0] !== null && "id" in v[0]));

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export const useAgentEvents = (gatewayUrl: string): ShellState => {
  const [state, dispatch] = useReducer(reduce, initialState);

  const clientRef = useRef<GatewayClient | null>(null);
  const streamSegmentsRef = useRef<StreamSegments>(createStreamSegments());
  // Raw label text per toolCallId — retained for display after removal from toolLabels map
  const toolLabelTextRef = useRef<Map<string, string>>(new Map());
  // Ref to busy so event handler closures read current value
  const busyRef = useRef(state.busy);
  busyRef.current = state.busy;

  // ---------------------------------------------------------------------------
  // Streaming helpers
  // ---------------------------------------------------------------------------

  const flushStreamingLine = useCallback((): void => {
    const flushed = flushStreamSegment(streamSegmentsRef.current);
    streamSegmentsRef.current = flushed.state;
    dispatch({ type: "flush_streaming", line: flushed.line });
  }, []);

  // ---------------------------------------------------------------------------
  // Gateway event handler
  // ---------------------------------------------------------------------------

  const handleEvent = useCallback((event: GatewayEvent): void => {
    if (event.type === "event") {
      const e = event.event;

      if (e.type === "message_update" && e.streamEvent.type === "text_delta") {
        const next = appendStreamDelta(streamSegmentsRef.current, e.streamEvent.delta);
        streamSegmentsRef.current = next;
        dispatch({ type: "streaming_delta", segment: next.segment });

      } else if (e.type === "tool_execution_start") {
        flushStreamingLine();
        const label = buildToolLabel(e.toolName, e.args);
        toolLabelTextRef.current.set(e.toolCallId, label);
        dispatch({ type: "tool_start", toolCallId: e.toolCallId, label, isTodo: e.toolName === "todo" });

      } else if (e.type === "tool_execution_end") {
        const label = toolLabelTextRef.current.get(e.toolCallId) ?? e.toolName;
        toolLabelTextRef.current.delete(e.toolCallId);
        dispatch({
          type: "tool_end",
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          isError: e.result.isError,
          label,
        });

      } else if (e.type === "message_start" && e.message.role === "user") {
        const content = typeof e.message.content === "string" ? e.message.content : null;
        if (content !== null) {
          flushStreamingLine();
          const advisory = parseAdvisoryMessage(content);
          dispatch({ type: "mark_queued_steer" });
          dispatch({
            type: "append_line",
            line: advisory
              ? { kind: "advisory", ...advisory }
              : { kind: "user", text: content },
          });
        }

      } else if (e.type === "compaction_end") {
        dispatch({ type: "append_line", line: { kind: "assistant", text: "Context compacted." } });

      } else if (e.type === "moa_reference_start") {
        dispatch({
          type: "append_line",
          line: { kind: "assistant", text: `⟐ MoA reference ${e.index + 1}/${e.count} (${e.model})...` },
        });

      } else if (e.type === "moa_reference_end") {
        const summary = e.text.startsWith("[failed:") ? "[failed]" : e.text.slice(0, 80);
        dispatch({ type: "update_last_moa_ref", index: e.index + 1, model: e.model, summary });

      } else if (e.type === "moa_aggregating") {
        dispatch({
          type: "append_line",
          line: { kind: "assistant", text: `⟐ Aggregating from ${e.refCount} reference${e.refCount === 1 ? "" : "s"}...` },
        });

      } else if (e.type === "subagent_start") {
        dispatch({
          type: "append_line",
          line: { kind: "tool", text: `⟐ Subagent ${e.index + 1}/${e.count}: ${e.goal}`, pending: true },
        });

      } else if (e.type === "subagent_end") {
        dispatch({
          type: "append_line",
          line: { kind: "tool", text: `⟐ Subagent ${e.index + 1}: ${e.goal}`, pending: false },
        });
      }
      // agent_start, agent_end, turn_start, turn_end,
      // message_start (assistant role), message_end, compaction_start → no-op

    } else if (event.type === "approval_request") {
      dispatch({ type: "approval_request", command: event.command });

    } else if (event.type === "clarify_request") {
      dispatch({ type: "clarify_request", question: event.question, choices: event.choices });

    } else if (event.type === "state_update") {
      const wasBusy = busyRef.current;
      const nowBusy = event.state.running;
      dispatch({ type: "state_update", busy: nowBusy, model: event.state.model, todos: event.state.todos });

      if (wasBusy && !nowBusy) {
        const finalSegment = finishStreamSegments("", streamSegmentsRef.current);
        streamSegmentsRef.current = createStreamSegments();
        dispatch({ type: "run_complete", finalSegment });
      }
    }
  }, [flushStreamingLine]);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const client = createGatewayClient(gatewayUrl);
    clientRef.current = client;

    // Poll connection status into React state (lightweight; no events from WS for this)
    const statusPoll = setInterval(() => {
      dispatch({ type: "set_connected", status: client.status() });
    }, 500);

    const unsubscribe = client.subscribe(handleEvent);

    // Hydrate initial state
    void client.request({ id: nextCmdId(), type: "get_state" }).then(response => {
      if (response.success && isStateData(response.data)) {
        dispatch({ type: "state_update", busy: response.data.running, model: response.data.model, todos: response.data.todos });
      }
    });

    return () => {
      clearInterval(statusPoll);
      unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [gatewayUrl, handleEvent]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const submit = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;

    if (trimmed.startsWith("/")) {
      handleSlashCommand(trimmed);
      return;
    }

    const client = clientRef.current;
    if (busyRef.current) {
      client?.send({ id: nextCmdId(), type: "steer", message: trimmed });
      dispatch({ type: "mark_queued_steer" });
    } else {
      dispatch({ type: "append_line", line: { kind: "user", text: trimmed } });
      dispatch({ type: "reset_streaming" });
      streamSegmentsRef.current = createStreamSegments();
      // Optimistically mark busy so the composer updates immediately
      dispatch({ type: "state_update", busy: true, model: state.model, todos: state.todos });
      client?.send({ id: nextCmdId(), type: "prompt", message: trimmed });
    }
  // state.model / state.todos are stable references consumed only at call time
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.model, state.todos]);

  const handleSlashCommand = useCallback((text: string): void => {
    const { command } = parseSlashCommand(text);

    if (command === "/clear") {
      dispatch({ type: "clear_lines" });
      return;
    }

    if (command === "/help") {
      dispatch({ type: "append_line", line: { kind: "assistant", text: HELP_TEXT } });
      return;
    }

    if (command === "/model") {
      const id = nextCmdId();
      void clientRef.current?.request({ id, type: "get_available_models" }).then(response => {
        if (response.success && isModelArray(response.data)) {
          dispatch({ type: "set_models", models: response.data });
          dispatch({ type: "set_overlay", overlay: { kind: "model", selectedIndex: 0 } });
        } else {
          dispatch({
            type: "append_line",
            line: { kind: "error", text: `Failed to load models: ${response.error ?? "unknown error"}` },
          });
        }
      });
      return;
    }

    if (command === "/compact") {
      clientRef.current?.send({ id: nextCmdId(), type: "compact" });
      dispatch({ type: "append_line", line: { kind: "assistant", text: "Compacting…" } });
      return;
    }

    if (command === "/settings") {
      dispatch({ type: "set_overlay", overlay: { kind: "action", selectedIndex: 0 } });
      return;
    }

    const unimplemented = ["/moa", "/trust", "/branch", "/fork", "/rollback", "/exit", "/dream", "/cron"];
    if (unimplemented.includes(command)) {
      dispatch({
        type: "append_line",
        line: { kind: "error", text: `${command} is not yet implemented in the desktop app.` },
      });
      return;
    }

    dispatch({ type: "append_line", line: { kind: "error", text: `Unknown command: ${command}` } });
  }, []);

  const abort = useCallback((): void => {
    clientRef.current?.send({ id: nextCmdId(), type: "abort" });
    dispatch({ type: "abort_done" });
  }, []);

  const approveCommand = useCallback((approved: boolean): void => {
    clientRef.current?.send({ id: nextCmdId(), type: "approve", approved });
    dispatch({ type: "approve_done" });
  }, []);

  const answerClarify = useCallback((answer: string): void => {
    clientRef.current?.send({ id: nextCmdId(), type: "clarify_response", answer });
    dispatch({ type: "clarify_done" });
  }, []);

  const setModel = useCallback((modelId: string): void => {
    clientRef.current?.send({ id: nextCmdId(), type: "set_model", modelId });
    dispatch({ type: "set_model_optimistic", modelId });
  }, []);

  const setOverlay = useCallback((overlay: OverlayState | null): void => {
    dispatch({ type: "set_overlay", overlay });
  }, []);

  const navigateOverlay = useCallback((index: number): void => {
    dispatch({ type: "navigate_overlay", index });
  }, []);

  const clearLines = useCallback((): void => {
    dispatch({ type: "clear_lines" });
  }, []);

  return {
    lines: state.lines,
    streaming: state.streaming,
    busy: state.busy,
    queuedSteer: state.queuedSteer,
    toolLabels: state.toolLabels,
    todos: state.todos,
    todoLoading: state.todoLoading,
    model: state.model,
    cwd: "",
    gitStatus: { branch: null, dirty: false },
    overlay: state.overlay,
    composerMode: state.composerMode,
    connected: state.connected,
    pendingCommand: state.pendingCommand,
    pendingClarify: state.pendingClarify,
    availableModels: state.availableModels,
    activeMoaPreset: null,
    submit,
    abort,
    approveCommand,
    answerClarify,
    setModel,
    setOverlay,
    navigateOverlay,
    clearLines,
  };
};
