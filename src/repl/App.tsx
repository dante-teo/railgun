import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { MultilineInput } from "ink-multiline-input";
import Spinner from "ink-spinner";
import type { DevinMessage, DevinModel } from "widevin";
import { createAgentSession } from "../agent/agentSession.js";
import type { AgentSession } from "../agent/agentSession.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { COMPACTION_ACK_MESSAGE, runCompaction } from "../agent/compaction.js";
import { describeDevinError } from "../errors.js";
import { buildToolLabel } from "../tools/toolLabel.js";
import type { ToolResult } from "../agent/events.js";
import { createTodoStore, summarizeTodos } from "../tools/todo.js";
import type { NormalizedTodoItem, TodoState, TodoStore } from "../tools/todo.js";
import { buildSessionCore } from "../session.js";
import type { DevinSession } from "../session.js";
import { loadConfig, parseMoAPreset, setConfiguredModel, isAdvisorActive, updateConfig } from "../config.js";
import type { MoAPreset } from "../agent/moa.js";
import type { CommandApprovalMode } from "../security/commandApproval.js";
import { HELP_TEXT, findMatches, nextCompletionState, parseSlashCommand } from "../commands.js";
import { toolLineIcon, approvalColor, shouldAppendToolTranscriptLine, shouldShowToolLine } from "./toolLineStyle.js";
import { ModelRow, resolveModelCommand } from "./ModelChooser.js";
import { Suggestions } from "./Suggestions.js";
import { moveSelection, selectionListWindow } from "./SessionChooser.js";
import { getGitStatus, formatCwd } from "./statusLine.js";
import type { GitStatus } from "./statusLine.js";
import { appendStreamDelta, createStreamSegments, finishStreamSegments, flushStreamSegment } from "./streamingTranscript.js";
import { useTerminalSize } from "./terminalSize.js";
import { composerRows, enhancedKeyboardMode, replaceComposerDraft, sanitizeComposerInput, shouldHandleComposerEvent } from "./composer.js";
import { ctrlCAction, hasCtrlCAbortTarget, runInAlternateScreen, runWithMouseTracking, shouldUseAlternateScreen } from "./lifecycle.js";
import { renderAssistantMarkdown } from "./markdown.js";
import { parseMouseWheel } from "./mouse.js";
import { ThemeController, themeForMode } from "./theme.js";
import type { Theme, ThemeMode } from "./theme.js";
import { createViewport, reduceViewport, visibleViewportRows } from "./viewport.js";
import type { TrustChoice, TrustDecision, ProjectTrustStore } from "../trust.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { MemoryStore } from "../persistence/memoryStore.js";
import type { NoteStore } from "../persistence/noteStore.js";
import { runDreamSession } from "../dream/dreamJob.js";
import { expandSkillCommand } from "../skills.js";
import { loadJobs, saveJobs, validateJob, CronJobsError } from "../cron/jobs.js";
import { CRON_PATH } from "../paths.js";
import type { AdviceSeverity } from "../advisor/advisoryContext.js";
import { parseAdvisoryMessage } from "../advisor/advisoryMessage.js";
import { Selector, createSelectorState, reduceSelector } from "./selector.js";
import type { SelectorItem, SelectorState } from "./selector.js";
import { createAgentDiagnosticsBridge } from "../diagnostics/agentBridge.js";
import { createNoopInteractiveDiagnostics } from "../diagnostics/interactiveDiagnostics.js";
import type { InteractiveDiagnostics } from "../diagnostics/interactiveDiagnostics.js";
import { statusText } from "../diagnostics/status.js";
import type { DiagnosticStatus } from "../diagnostics/status.js";
import { diagnosticSlashPhase } from "../diagnostics/slashCommand.js";

const TRUST_CHOICES: readonly { readonly label: string; readonly value: TrustChoice }[] = [
  { label: "Trust", value: "trust" },
  { label: "Trust (this session only)", value: "trust-session" },
  { label: "Do not trust", value: "deny" },
];
const NOOP_DIAGNOSTICS = createNoopInteractiveDiagnostics();

export interface DisplayLine {
  kind: "user" | "assistant" | "advisory" | "error" | "tool";
  text: string;
  severity?: AdviceSeverity;
  failed?: boolean;
  partial?: boolean;
  pending?: boolean;
}

export interface ReplSessionMetadata {
  id: string;
  model: string;
  startedAt: string;
}

export interface ReplPersistenceOptions {
  initialHistory?: readonly DevinMessage[];
  initialTodos?: TodoState;
  sessionMetadata?: ReplSessionMetadata;
  checkpoint?: (messages: readonly DevinMessage[], todos: TodoState) => void;
  branch?: (messageId: number) => void;
  branchWithSummary?: (messageId: number) => Promise<void>;
  fork?: () => { sessionId: string; messages: readonly DevinMessage[] };
  getRecentMessages?: () => readonly { id: number; role: string; preview: string }[];
  loadBranch?: () => readonly DevinMessage[];
}

export interface CheckpointAttempt {
  unsaved: boolean;
  recovered: boolean;
  error?: string;
}

type UserMessage = DevinMessage & { role: "user" };
const isUserMessage = (message: DevinMessage): message is UserMessage => message.role === "user";

const userContentText = (message: UserMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join(" ");

export { parseAdvisoryMessage } from "../advisor/advisoryMessage.js";

const assistantContentText = (message: Extract<DevinMessage, { role: "assistant" }>): string =>
  message.content.filter(part => part.type === "text").map(part => part.text).join("");

export const historyToDisplayLines = (history: readonly DevinMessage[]): readonly DisplayLine[] => {
  return history.reduce<readonly DisplayLine[]>((lines, message) => {
    if (isUserMessage(message)) {
      const text = userContentText(message);
      const advisory = parseAdvisoryMessage(text);
      return [...lines, advisory ? { kind: "advisory", ...advisory } : { kind: "user", text }];
    }
    if (message.role !== "assistant") return lines;
    const text = assistantContentText(message);
    if (text === "") return lines;
    const prior = lines.at(-1);
    return prior?.kind === "assistant"
      ? [...lines.slice(0, -1), { ...prior, text: prior.text + text }]
      : [...lines, { kind: "assistant", text }];
  }, []);
};

export const createHydratedTodoStore = (todos: TodoState): TodoStore => createTodoStore(todos);

export const attemptCheckpoint = (
  checkpoint: (messages: readonly DevinMessage[], todos: TodoState) => void,
  messages: readonly DevinMessage[],
  todos: TodoState,
  wasUnsaved: boolean,
): CheckpointAttempt => {
  try {
    checkpoint(messages, todos);
    return { unsaved: false, recovered: wasUnsaved };
  } catch (error) {
    return {
      unsaved: true,
      recovered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const todoGlyph = (status: NormalizedTodoItem["status"]): string =>
  status === "completed" ? "[x]" : status === "cancelled" ? "[-]" : status === "in_progress" ? "[>]" : "[ ]";

export const TodoPanel = ({ todos, isLoading, theme }: { todos: TodoState; isLoading: boolean; theme: Theme }): React.ReactElement | null => {
  if (todos.length === 0 && !isLoading) return null;
  const summary = summarizeTodos(todos);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.strong} bold>Todos · {summary.completed}/{summary.total}</Text>
      {isLoading && todos.length === 0 && (
        <Text color={theme.accent}><Spinner type="dots" /> Crafting todos</Text>
      )}
      {todos.map(todo => (
        <Box key={todo.id}>
          <Text color={todo.status === "completed" ? theme.success : todo.status === "in_progress" ? theme.accent : theme.dim}>
            {todoGlyph(todo.status)}{" "}
          </Text>
          <Text color={theme.text}>{todo.content}</Text>
        </Box>
      ))}
    </Box>
  );
};

export { shouldAppendToolTranscriptLine, shouldShowToolLine } from "./toolLineStyle.js";

const Header = ({ theme }: { readonly theme: Theme }): React.ReactElement => (
  <Box borderStyle="single" borderColor={theme.border} paddingX={1} height={3}>
    <Text color={theme.strong} bold>RAILGUN</Text>
    <Text color={theme.muted}> · adaptive agent console</Text>
  </Box>
);

const ROLE_GUTTER_WIDTH = 10;

export interface TranscriptRow {
  readonly kind: DisplayLine["kind"];
  readonly role: string;
  readonly text: string;
  readonly failed: boolean;
  readonly pending: boolean;
  readonly severity?: AdviceSeverity;
}

const advisoryColor = (severity: AdviceSeverity | undefined, theme: Theme): string =>
  severity === "blocker" ? theme.error : severity === "concern" ? theme.warning : theme.success;

const advisorySurface = (severity: AdviceSeverity | undefined, theme: Theme): string =>
  severity === "blocker" ? theme.errorSurface : severity === "concern" ? theme.warningSurface : theme.successSurface;

const chunkText = (text: string, width: number): readonly string[] =>
  text === "" ? [""] : Array.from({ length: Math.ceil(text.length / width) }, (_, index) => text.slice(index * width, (index + 1) * width));

const wrapPlainText = (text: string, width: number): readonly string[] =>
  text.split("\n").flatMap(line => chunkText(line, Math.max(1, width)));

export const displayLineToTranscriptRows = (line: DisplayLine, theme: Theme, width: number): readonly TranscriptRow[] => {
  const bodyWidth = Math.max(8, width - ROLE_GUTTER_WIDTH - 2);
  const contentWidth = Math.max(8, bodyWidth - (line.kind === "tool" || line.partial ? 3 : 0));
  const role = line.kind === "user" ? "YOU" : line.kind === "advisory" ? "ADVISOR" : line.kind === "error" ? "ERROR" : line.kind === "tool" ? "TOOL" : "RAILGUN";
  const rendered = line.kind === "assistant" && !line.partial
    ? renderAssistantMarkdown(line.text, theme, bodyWidth).replace(/^\n+|\n+$/g, "").split("\n")
    : wrapPlainText(line.text || (line.partial ? "Thinking" : ""), contentWidth);
  return rendered.map((text, index) => ({
    kind: line.kind,
    role: index === 0 ? role : "",
    text: line.kind === "advisory" && index === 0 ? `${(line.severity ?? "nit").toUpperCase()} · ${text}` : text,
    failed: !!line.failed,
    pending: !!line.pending || (!!line.partial && line.text === ""),
    ...(line.severity ? { severity: line.severity } : {}),
  }));
};

export const TranscriptRowLine = ({ row, theme }: { readonly row: TranscriptRow; readonly theme: Theme }): React.ReactElement => {
  const roleColor = row.kind === "error" || row.failed ? theme.error
    : row.kind === "advisory" ? advisoryColor(row.severity, theme)
    : row.kind === "user" ? theme.accent
    : row.kind === "tool" && !row.pending ? theme.success
    : theme.strong;
  const backgroundColor = row.kind === "user" ? theme.surface
    : row.kind === "advisory" ? advisorySurface(row.severity, theme)
    : row.kind === "tool" ? row.failed ? theme.errorSurface : row.pending ? theme.warningSurface : theme.successSurface
    : undefined;
  return (
    <Box flexDirection="row" backgroundColor={backgroundColor}>
      <Box width={ROLE_GUTTER_WIDTH} flexShrink={0}>
        <Text color={roleColor} bold>{row.role}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text color={row.kind === "error" || row.failed ? theme.error : row.kind === "advisory" ? roleColor : row.kind === "tool" && row.pending ? theme.warning : theme.text}>
          {row.pending && <><Spinner type="dots2" />{" "}</>}
          {row.kind === "tool" && !row.pending && row.role !== "" ? `${toolLineIcon(row.failed)} ` : ""}
          {row.text}{row.pending ? "…" : ""}
        </Text>
      </Box>
    </Box>
  );
};

export const TranscriptLine = ({ line, theme, width }: { readonly line: DisplayLine; readonly theme: Theme; readonly width: number }): React.ReactElement => (
  <Box flexDirection="column">
    {displayLineToTranscriptRows(line, theme, width).map((row, index) => <TranscriptRowLine key={index} row={row} theme={theme} />)}
  </Box>
);

export const transcriptJustification = (
  visibleRows: number,
  hasUnseenCue: boolean,
  viewportRows: number,
): "flex-start" | "flex-end" =>
  visibleRows + (hasUnseenCue ? 1 : 0) < viewportRows ? "flex-end" : "flex-start";

const StatusBar = ({
  theme, session, gitStatus, metadata, unsaved, viewportOffset, viewportRows, totalRows, activeMoaPreset, diagnosticStatus, now,
}: {
  readonly theme: Theme;
  readonly session: DevinSession;
  readonly gitStatus: GitStatus;
  readonly metadata?: ReplSessionMetadata;
  readonly unsaved: boolean;
  readonly viewportOffset: number;
  readonly viewportRows: number;
  readonly totalRows: number;
  readonly activeMoaPreset?: MoAPreset | null;
  readonly diagnosticStatus: DiagnosticStatus;
  readonly now: number;
}): React.ReactElement => {
  const position = totalRows === 0 ? "0/0" : `${Math.min(totalRows, viewportOffset + 1)}–${Math.min(totalRows, viewportOffset + viewportRows)}/${totalRows}`;
  return (
    <Box backgroundColor={theme.statusSurface} paddingX={1} height={1}>
      <Text color={theme.accent} wrap="truncate-end">{session.model.id}</Text>
      {activeMoaPreset && <Text color={theme.warning}> · MoA: {activeMoaPreset.name}</Text>}
      <Text color={theme.muted}> · {formatCwd(process.cwd())}</Text>
      {gitStatus.branch !== null && <Text color={gitStatus.dirty ? theme.warning : theme.success}> · {gitStatus.branch}{gitStatus.dirty ? "*" : ""}</Text>}
      {metadata && <Text color={theme.muted}> · {metadata.id.slice(0, 8)}</Text>}
      <Text color={unsaved ? theme.error : theme.success}> · {unsaved ? "unsaved" : "saved"}</Text>
      <Text color={diagnosticStatus.kind === "stalled" || diagnosticStatus.kind === "unavailable" ? theme.error : diagnosticStatus.kind === "working" ? theme.warning : theme.success}> · {statusText(diagnosticStatus, now)}</Text>
      <Text color={theme.dim}> · {position}</Text>
    </Box>
  );
};
interface ModelPickerState {
  readonly models: readonly DevinModel[];
  readonly selectedIndex: number;
  readonly sessionOnly: boolean;
}

interface ActionPickerState {
  readonly title: string;
  readonly items: readonly SelectorItem[];
  readonly selector: SelectorState;
  readonly onSelect: (index: number) => void | Promise<void>;
}


const ChatApp = ({
  session, initialMode, themeController, persistence = {}, initialTrustDecision, trustStore, cwd, extensionRunner, memoryStore, noteStore, diagnostics = NOOP_DIAGNOSTICS,
}: {
  readonly session: DevinSession;
  readonly initialMode: ThemeMode;
  readonly themeController: ThemeController;
  readonly persistence?: ReplPersistenceOptions;
  readonly initialTrustDecision?: TrustDecision;
  readonly trustStore?: ProjectTrustStore;
  readonly cwd?: string;
  readonly extensionRunner?: ExtensionRunner;
  readonly memoryStore?: MemoryStore;
  readonly noteStore?: NoteStore;
  readonly diagnostics?: InteractiveDiagnostics;
}): React.ReactElement => {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { write: stdoutWrite } = useStdout();
  const { columns, rows } = useTerminalSize();
  const [mode, setMode] = useState(initialMode);
  const theme = themeForMode(mode);
  useEffect(() => themeController.subscribe(setMode), [themeController]);
  const [activeSession, setActiveSession] = useState(session);
  const [history, setHistory] = useState<readonly DevinMessage[]>(persistence.initialHistory ?? []);
  const [lines, setLines] = useState<readonly DisplayLine[]>(() => historyToDisplayLines(persistence.initialHistory ?? []));
  const [draft, setDraft] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);
  const [completionIndex, setCompletionIndex] = useState<number | null>(null);
  const [completionMatches, setCompletionMatches] = useState<readonly string[]>([]);
  const liveMatches = useMemo(() => (draft.startsWith("/") && !draft.includes(" ") ? findMatches(draft) : []), [draft]);
  const [streaming, setStreaming] = useState("");
  const streamSegmentsRef = useRef(createStreamSegments());
  const [busy, setBusy] = useState(false);
  const activeAgentRef = useRef<AgentSession | null>(null);
  const [queuedSteer, setQueuedSteer] = useState(false);
  const [toolLabels, setToolLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const toolLabelTextRef = useRef(new Map<string, string>());
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const iterationBudgetRef = useRef(IterationBudget.create());
  const todoStoreRef = useRef<TodoStore>(createHydratedTodoStore(persistence.initialTodos ?? []));
  const [todos, setTodos] = useState<TodoState>(todoStoreRef.current.read());
  const [checkpointUnsaved, setCheckpointUnsaved] = useState(false);
  const [todoLoading, setTodoLoading] = useState(false);
  const pendingApprovalRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);
  const [pendingClarify, setPendingClarify] = useState<{ question: string; choices?: string[] } | null>(null);
  const pendingClarifyRef = useRef<{ resolve: (answer: string) => void } | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus>({ branch: null, dirty: false });
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  const [actionPicker, setActionPicker] = useState<ActionPickerState | null>(null);
  const [trustDecision, setTrustDecision] = useState<TrustDecision>(initialTrustDecision ?? { status: "unknown" });
  const [pendingTrust, setPendingTrust] = useState(false);
  const [trustSelector, setTrustSelector] = useState(() => createSelectorState(TRUST_CHOICES.length, TRUST_CHOICES.length));
  const [clarifySelector, setClarifySelector] = useState(() => createSelectorState(0, 4));
  const [approvalMode, setApprovalMode] = useState<CommandApprovalMode>("manual");
  const [reviewerModel, setReviewerModel] = useState<string | undefined>(undefined);
  const [operationTimeoutMs, setOperationTimeoutMs] = useState(600_000);
  const [activeMoaPreset, setActiveMoaPreset] = useState<MoAPreset | null>(null);
  const [advisorModel, setAdvisorModel] = useState<string | undefined>(undefined);
  const sessionApprovalsRef = useRef(new Set<string>());
  const [diagnosticStatus, setDiagnosticStatus] = useState(diagnostics.status);
  const [diagnosticNow, setDiagnosticNow] = useState(performance.now());
  useEffect(() => diagnostics.subscribe(setDiagnosticStatus), [diagnostics]);
  useEffect(() => {
    const timer = setInterval(() => setDiagnosticNow(performance.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    diagnostics.observer.event({ event: "terminal_resize", terminalColumns: columns, terminalRows: rows });
  }, [columns, diagnostics, rows]);
  useEffect(() => { void getGitStatus(process.cwd()).then(setGitStatus); }, []);
  useEffect(() => {
    void loadConfig().then(c => {
      if (c.approvalMode) setApprovalMode(c.approvalMode);
      if (c.reviewerModel) setReviewerModel(c.reviewerModel);
      if (c.operationTimeoutMs) setOperationTimeoutMs(c.operationTimeoutMs);
      if (isAdvisorActive(c)) setAdvisorModel(c.advisor!.model!);
      if (c.activeMoaPreset && c.moaPresets?.[c.activeMoaPreset]) setActiveMoaPreset(parseMoAPreset(c.activeMoaPreset, c.moaPresets[c.activeMoaPreset]));
    }).catch(console.error);
  }, []);

  const composerHeight = composerRows(draft, columns, rows);
  const suggestionCount = completionMatches.length > 1 ? completionMatches.length : liveMatches.length;
  const todoRows = todos.length === 0 && !todoLoading ? 0 : todos.length + 2;
  const pickerVisibleCount = modelPicker ? Math.max(1, Math.min(modelPicker.models.length, Math.floor((rows - 15) / 3))) : 0;
  const pickerRows = modelPicker ? pickerVisibleCount * 3 + 1 : 0;
   const clarifyRows = pendingClarify ? 2 + (pendingClarify.choices?.length ?? 0) : 0;
   const trustPickerRows = pendingTrust ? 8 : 0;
   const actionPickerRows = actionPicker ? Math.min(actionPicker.items.length, actionPicker.selector.visibleCount) + 3 : 0;
   const lowerRows = composerHeight + 3 + todoRows + suggestionCount + (pendingCommand ? 1 : 0) + pickerRows + clarifyRows + trustPickerRows + actionPickerRows + 1;
  const transcriptRows = Math.max(1, rows - 3 - lowerRows);
  const ephemeralLines: readonly DisplayLine[] = busy
    ? toolLabels.size > 0
      ? [...toolLabels.values()].map(text => ({ kind: "tool" as const, text, pending: true }))
      : [{ kind: "assistant" as const, text: streaming, partial: true }]
    : [];
  const transcriptLines = ephemeralLines.length > 0 ? [...lines, ...ephemeralLines] : lines;
  const physicalTranscriptRows = transcriptLines.flatMap(line => displayLineToTranscriptRows(line, theme, columns));
  const [viewport, dispatchViewport] = useReducer(reduceViewport, createViewport(physicalTranscriptRows.length, transcriptRows));
  useEffect(() => dispatchViewport({ type: "resize", viewportRows: transcriptRows }), [transcriptRows]);
  useEffect(() => dispatchViewport({ type: "content", totalRows: physicalTranscriptRows.length }), [physicalTranscriptRows.length]);
  useEffect(() => {
    const onMouseInput = (data: Buffer | string): void => {
      parseMouseWheel(data.toString()).forEach(direction => {
        dispatchViewport({ type: "scroll", delta: direction === "up" ? -3 : 3 });
      });
    };
    stdin.on("data", onMouseInput);
    return () => { stdin.off("data", onMouseInput); };
  }, [stdin]);

  useInput((_input, key) => {
    if (key.pageUp) dispatchViewport({ type: "page-up" });
    else if (key.pageDown) dispatchViewport({ type: "page-down" });
    else if (key.home) dispatchViewport({ type: "home" });
    else if (key.end) dispatchViewport({ type: "end" });
  });

  useInput((input, key) => {
    if (!(key.ctrl && input.toLowerCase() === "c")) return;
    if (ctrlCAction(hasCtrlCAbortTarget(activeAgentRef.current, pendingApprovalRef.current ?? pendingClarifyRef.current)) === "exit") { exit(); return; }
    activeAgentRef.current?.abort();
    diagnostics.observer.event({ event: "cancellation", outcome: "abort" });
    pendingApprovalRef.current?.resolve(false);
    pendingApprovalRef.current = null;
    setPendingCommand(null);
    pendingClarifyRef.current?.resolve("[user declined to answer]");
    pendingClarifyRef.current = null;
    setPendingClarify(null);
  });

  const confirmShellCommand = useCallback((command: string): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const operation = diagnostics.observer.start({ phase: "approval", exempt: true });
    pendingApprovalRef.current = { resolve: approved => { operation.end(approved ? "success" : "abort"); resolve(approved); } };
    setPendingCommand(command);
    return promise;
  }, [diagnostics]);

  const clarifyCallback = useCallback((question: string, choices?: string[]): Promise<string> => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const operation = diagnostics.observer.start({ phase: "clarification", exempt: true });
    pendingClarifyRef.current = { resolve: answer => { operation.end(answer === "[user declined to answer]" ? "abort" : "success"); resolve(answer); } };
    setPendingClarify({ question, ...(choices !== undefined ? { choices: choices.slice(0, 4) } : {}) });
    setClarifySelector(createSelectorState(choices?.slice(0, 4).length ?? 0, 4));
    return promise;
  }, [diagnostics]);

  useInput((_input, key) => {
    const pending = pendingClarifyRef.current;
    const clarify = pendingClarify;
    if (!pending || !clarify) return;
    if (clarify.choices && clarify.choices.length > 0) {
      if (key.upArrow || key.downArrow) {
        setClarifySelector(state => reduceSelector(state, { type: key.upArrow ? "up" : "down" }));
        return;
      }
      if (key.return) {
        pending.resolve(clarify.choices[clarifySelector.selectedIndex] ?? "");
        pendingClarifyRef.current = null;
        setPendingClarify(null);
        return;
      }
    }
    if (key.escape) {
      pending.resolve("[user declined to answer]");
      pendingClarifyRef.current = null;
      setPendingClarify(null);
    }
  }, { isActive: pendingClarify !== null && (pendingClarify.choices?.length ?? 0) > 0 });

  useInput((_input, key) => {
    if (!actionPicker) return;
    if (key.upArrow || key.downArrow) {
      setActionPicker(current => current && ({ ...current, selector: reduceSelector(current.selector, { type: key.upArrow ? "up" : "down" }) }));
    } else if (key.return) {
      const { selectedIndex } = actionPicker.selector;
      const select = actionPicker.onSelect;
      setActionPicker(null);
      void Promise.resolve(select(selectedIndex)).catch(error => {
        setLines(previous => [...previous, { kind: "error", text: describeDevinError(error) ?? (error instanceof Error ? error.message : String(error)) }]);
      });
    } else if (key.escape) setActionPicker(null);
  }, { isActive: actionPicker !== null });

  useInput((input, key) => {
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    if (input.toLowerCase() === "y") pending.resolve(true);
    else if (input.toLowerCase() === "n" || key.escape) pending.resolve(false);
    else return;
    pendingApprovalRef.current = null;
    setPendingCommand(null);
  }, { isActive: pendingCommand !== null });

  useInput((_input, key) => {
    if (!modelPicker) return;
    if (key.upArrow) {
      setModelPicker({ ...modelPicker, selectedIndex: moveSelection(modelPicker.selectedIndex, modelPicker.models.length, "up") });
    } else if (key.downArrow) {
      setModelPicker({ ...modelPicker, selectedIndex: moveSelection(modelPicker.selectedIndex, modelPicker.models.length, "down") });
    } else if (key.return) {
      const chosen = modelPicker.models[modelPicker.selectedIndex];
      if (!chosen) return;
      const persist = !modelPicker.sessionOnly;
      setModelPicker(null);
      setBusy(true);
      void (async () => {
      try {
          const rebuilt = await buildSessionCore(activeSession.devin, chosen);
          if (persist) await setConfiguredModel(chosen.id);
          setActiveSession(rebuilt);
          setLines(previous => [...previous, { kind: "assistant", text: persist
            ? `Switched to ${chosen.id} and saved as your default.`
            : `Using ${chosen.id} for this session only (not saved).` }]);
        } catch (error) {
          setLines(previous => [...previous, { kind: "error", text: describeDevinError(error) ?? (error instanceof Error ? error.message : String(error)) }]);
        } finally {
          setBusy(false);
        }
      })();
    } else if (key.escape) {
      setModelPicker(null);
    }
  }, { isActive: modelPicker !== null });

  useInput((_input, key) => {
    if (!pendingTrust) return;
    if (key.upArrow || key.downArrow) {
      setTrustSelector(state => reduceSelector(state, { type: key.upArrow ? "up" : "down" }));
    } else if (key.return && trustStore !== undefined) {
      const newDecision = trustStore.set(cwd ?? process.cwd(), TRUST_CHOICES[trustSelector.selectedIndex]!.value);
      setTrustDecision(newDecision);
      setPendingTrust(false);
      const scopeLabel = "scope" in newDecision ? (newDecision.scope === "persisted" ? " (persisted)" : " (session only)") : "";
      setLines(previous => [...previous, { kind: "assistant", text: `Trust decision updated: ${newDecision.status}${scopeLabel}.` }]);
    } else if (key.escape) {
      setPendingTrust(false);
    }
  }, { isActive: pendingTrust });

  const completeSuggestion = useCallback(() => {
    const next = nextCompletionState(completionMatches, completionIndex, liveMatches, "tab");
    setCompletionMatches(next.frozenMatches);
    setCompletionIndex(next.index);
    const replacement = replaceComposerDraft(draft, next.input, composerRevision);
    setDraft(replacement.draft);
    setComposerRevision(replacement.revision);
  }, [completionMatches, completionIndex, composerRevision, draft, liveMatches]);

  useInput((_input, key) => {
    if (!key.escape || completionMatches.length === 0) return;
    const next = nextCompletionState(completionMatches, completionIndex, liveMatches, "escape");
    setCompletionMatches(next.frozenMatches);
    setCompletionIndex(next.index);
  }, { isActive: !busy && pendingCommand === null });

  const flushStreamingLine = useCallback(() => {
    const flushed = flushStreamSegment(streamSegmentsRef.current);
    streamSegmentsRef.current = flushed.state;
    if (flushed.line !== null) {
      const line = flushed.line;
      setLines(previous => [...previous, { kind: "assistant", text: line }]);
    }
    setStreaming("");
  }, []);

  const onToolExecutionStart = useCallback((toolCallId: string, toolName: string, args: unknown) => {
    flushStreamingLine();
    if (toolName === "todo") setTodoLoading(true);
    const label = buildToolLabel(toolName, args);
    toolLabelTextRef.current.set(toolCallId, label);
    setToolLabels(previous => { const next = new Map(previous); next.set(toolCallId, label); return next; });
  }, [flushStreamingLine]);

  const onToolExecutionEnd = useCallback((toolCallId: string, toolName: string, result: ToolResult) => {
    const label = toolLabelTextRef.current.get(toolCallId) ?? toolName;
    toolLabelTextRef.current.delete(toolCallId);
    setToolLabels(previous => { const next = new Map(previous); next.delete(toolCallId); return next; });
    if (!shouldAppendToolTranscriptLine(toolName)) { setTodoLoading(false); setTodos(todoStoreRef.current.read()); }
    if (shouldShowToolLine(toolName, result.isError)) {
      setLines(previous => [...previous, { kind: "tool", text: label, failed: result.isError }]);
    }
  }, []);

  const handleSubmit = useCallback(async (value: string) => {
    let text = value.trim();
    if (text === "") return;
    if (pendingClarify !== null && pendingClarifyRef.current !== null) {
      pendingClarifyRef.current.resolve(text);
      pendingClarifyRef.current = null;
      setPendingClarify(null);
      setDraft("");
      return;
    }
    setDraft("");
    setCompletionIndex(null);
    setCompletionMatches([]);
    if (busy && pendingCommand === null && activeAgentRef.current !== null) {
      activeAgentRef.current.steer(text);
      diagnostics.observer.event({ event: "steering_queued", outcome: "progress" });
      setQueuedSteer(true);
      return;
    }
    if (text.startsWith("/")) {
      const { command, arg } = parseSlashCommand(text);
      const slashOperation = diagnostics.observer.start({ phase: diagnosticSlashPhase(command) });
      try {
        if (command === "/exit") { exit(); return; }
        if (command === "/help") {
          setLines(previous => [...previous, { kind: "assistant", text: HELP_TEXT }]);
          return;
        }
        if (command === "/clear") {
          stdoutWrite("\u001b[2J\u001b[H");
          return;
        }
        if (command === "/model") {
          try {
            const models = await activeSession.devin.listModels();
            const result = resolveModelCommand(arg, models, activeSession.model.id);
            if (result.kind === "show") {
              const activeIndex = models.findIndex(m => m.id === activeSession.model.id);
              setModelPicker({ models, selectedIndex: Math.max(0, activeIndex), sessionOnly: result.sessionOnly });
            } else if (result.kind === "error") {
              setLines(previous => [...previous, { kind: "error", text: result.message }]);
            } else {
              try {
                const rebuilt = await buildSessionCore(activeSession.devin, result.model);
                if (result.persist) await setConfiguredModel(result.model.id);
                setActiveSession(rebuilt);
                setLines(previous => [...previous, { kind: "assistant", text: result.persist
                  ? `Switched to ${result.model.id} and saved as your default.`
                  : `Using ${result.model.id} for this session only (not saved).` }]);
              } catch (error) {
                setLines(previous => [...previous, { kind: "error", text: describeDevinError(error) ?? (error instanceof Error ? error.message : String(error)) }]);
              }
            }
          } catch (error) {
            setLines(previous => [...previous, { kind: "error", text: describeDevinError(error) ?? (error instanceof Error ? error.message : String(error)) }]);
          }
          return;
        }
        if (command === "/settings") {
          try {
            const config = await loadConfig();
            const models = await activeSession.devin.listModels();
            const openModelSetting = (): void => setActionPicker({
              title: "Settings · Primary model",
              items: models.map(model => ({ id: model.id, label: model.id, current: model.id === activeSession.model.id })),
              selector: createSelectorState(models.length, Math.min(8, models.length), Math.max(0, models.findIndex(model => model.id === activeSession.model.id))),
              onSelect: async index => {
                const model = models[index];
                if (!model) return;
                const rebuilt = await buildSessionCore(activeSession.devin, model);
                await setConfiguredModel(model.id);
                setActiveSession(rebuilt);
                setLines(previous => [...previous, { kind: "assistant", text: `Primary model changed to ${model.id}.` }]);
              },
            });
            const openMoaSetting = (): void => {
              const names = Object.keys(config.moaPresets ?? {});
              const values = ["Off", ...names];
              setActionPicker({ title: "Settings · Default MoA preset", items: values.map(name => ({ id: name, label: name, current: name === (config.activeMoaPreset ?? "Off") })), selector: createSelectorState(values.length, Math.min(8, values.length), Math.max(0, values.indexOf(config.activeMoaPreset ?? "Off"))), onSelect: async index => {
                const name = values[index]!;
                const updated = await updateConfig(current => {
                  if (name !== "Off") return { ...current, activeMoaPreset: name };
                  const { activeMoaPreset: _removed, ...rest } = current;
                  return rest as typeof current;
                });
                setActiveMoaPreset(name === "Off" ? null : parseMoAPreset(name, updated.moaPresets![name]));
                setLines(previous => [...previous, { kind: "assistant", text: name === "Off" ? "Default MoA disabled." : `Default MoA preset changed to ${name}.` }]);
              } });
            };
            const openAdvisorSetting = (): void => {
              const values = ["Off", ...models.map(model => model.id)];
              const current = isAdvisorActive(config) ? config.advisor!.model! : "Off";
              setActionPicker({ title: "Settings · Advisor", items: values.map(name => ({ id: name, label: name, current: name === current })), selector: createSelectorState(values.length, Math.min(8, values.length), Math.max(0, values.indexOf(current))), onSelect: async index => {
                const name = values[index]!;
                await updateConfig(value => ({ ...value, advisor: name === "Off" ? { ...value.advisor, enabled: false } : { ...value.advisor, enabled: true, model: name } }));
                setAdvisorModel(name === "Off" ? undefined : name);
                setLines(previous => [...previous, { kind: "assistant", text: name === "Off" ? "Advisor disabled." : `Advisor enabled with ${name}.` }]);
              } });
            };
            const sections = [openModelSetting, openMoaSetting, openAdvisorSetting];
            setActionPicker({ title: "AI Settings", items: [
              { id: "model", label: "Primary model", detail: activeSession.model.id },
              { id: "moa", label: "MOA", detail: config.activeMoaPreset ?? "Off" },
              { id: "advisor", label: "Advisor", detail: isAdvisorActive(config) ? config.advisor!.model! : "Off" },
            ], selector: createSelectorState(3, 3), onSelect: index => sections[index]?.() });
          } catch (error) {
            setLines(previous => [...previous, { kind: "error", text: `Settings error: ${error instanceof Error ? error.message : String(error)}` }]);
          }
          return;
        }
        if (command === "/compact") {
          setBusy(true);
          try {
            const result = await runCompaction(activeSession.devin, activeSession.model.id, activeSession.systemPrompt, history);
            const finalMessages: DevinMessage[] = [
              ...result.messages,
              { role: "assistant", content: [{ type: "text", text: COMPACTION_ACK_MESSAGE }] },
            ];
            setHistory(finalMessages);
            setLines(previous => [...previous, { kind: "assistant", text: COMPACTION_ACK_MESSAGE }]);
            if (persistence.checkpoint) {
              const checkpoint = attemptCheckpoint(persistence.checkpoint, finalMessages, todoStoreRef.current.read(), checkpointUnsaved);
              setCheckpointUnsaved(checkpoint.unsaved);
              if (checkpoint.error) {
                setLines(previous => [...previous, { kind: "error", text: `Session checkpoint was not saved (${checkpoint.error}). The compacted history is retained and will be retried.` }]);
              } else if (checkpoint.recovered) {
                setLines(previous => [...previous, { kind: "assistant", text: "Session checkpoint recovered." }]);
              }
            }
          } catch (error) {
            setLines(previous => [...previous, { kind: "error", text: describeDevinError(error) ?? String(error) }]);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (command === "/trust") {
          if (trustStore === undefined) {
            const statusText = trustDecision.status === "unknown" ? "unknown" : `${trustDecision.status} (${trustDecision.scope})`;
            setLines(previous => [...previous, { kind: "assistant", text: `Current trust status: ${statusText}. (Trust store not available in this session.)` }]);
          } else {
            setTrustSelector(createSelectorState(TRUST_CHOICES.length, TRUST_CHOICES.length));
            setPendingTrust(true);
          }
          return;
        }
        if (command === "/moa") {
          try {
            const moaConfig = await loadConfig();
            if (!arg || arg === "") {
              const presetNames = Object.keys(moaConfig.moaPresets ?? {});
              const items = ["Off", ...presetNames];
              setActionPicker({ title: "MoA for this session", items: items.map(name => ({ id: name, label: name, current: name === (activeMoaPreset?.name ?? "Off") })), selector: createSelectorState(items.length, Math.min(8, items.length), Math.max(0, items.indexOf(activeMoaPreset?.name ?? "Off"))), onSelect: index => {
                const name = items[index]!;
                if (name === "Off") { setActiveMoaPreset(null); setLines(previous => [...previous, { kind: "assistant", text: "MoA deactivated for this session." }]); }
                else { const preset = parseMoAPreset(name, moaConfig.moaPresets![name]); setActiveMoaPreset(preset); setLines(previous => [...previous, { kind: "assistant", text: `MoA activated: ${name}` }]); }
              } });
            } else if (arg === "off") {
              setActiveMoaPreset(null);
              setLines(previous => [...previous, { kind: "assistant", text: "MoA deactivated." }]);
            } else {
              const presets = moaConfig.moaPresets;
              if (!presets || !(arg in presets)) {
                setLines(previous => [...previous, { kind: "error", text: `Unknown MoA preset: "${arg}". Available: ${Object.keys(presets ?? {}).join(", ") || "none"}` }]);
              } else {
                const preset = parseMoAPreset(arg, presets[arg]);
                setActiveMoaPreset(preset);
                setLines(previous => [...previous, { kind: "assistant", text: `MoA activated: ${arg} (${preset.referenceModels.length} references → ${preset.aggregator.model})` }]);
              }
            }
          } catch (error) {
            setLines(previous => [...previous, { kind: "error", text: `MoA error: ${error instanceof Error ? error.message : String(error)}` }]);
          }
          return;
        }
        if (command === "/branch") {
          if (!persistence.branch || !persistence.getRecentMessages) {
            setLines(prev => [...prev, { kind: "error", text: "Branching not available (no persistence)." }]);
            return;
          }
          const withSummary = arg?.includes("--summary") ?? false;
          const idStr = arg?.replace("--summary", "").trim();
          if (!idStr || !/^\d+$/.test(idStr)) {
            const recent = persistence.getRecentMessages();
            setActionPicker({ title: "Branch from recent message", items: recent.map(msg => ({ id: String(msg.id), label: `[${msg.role}] ${msg.preview}` })), selector: createSelectorState(recent.length, Math.min(8, recent.length)), onSelect: async index => {
              const selected = recent[index];
              if (!selected) return;
              if (withSummary && persistence.branchWithSummary) await persistence.branchWithSummary(selected.id);
              else persistence.branch!(selected.id);
              if (persistence.loadBranch) {
                const newHistory = persistence.loadBranch();
                setHistory(newHistory);
                setLines(historyToDisplayLines(newHistory));
              }
              setLines(previous => [...previous, { kind: "assistant", text: `Branched to message ${selected.id}${withSummary ? " with summary" : ""}.` }]);
            } });
            return;
          }
          const messageId = parseInt(idStr, 10);
          try {
            if (withSummary && persistence.branchWithSummary) {
              setBusy(true);
              await persistence.branchWithSummary(messageId);
            } else {
              persistence.branch(messageId);
            }
            if (persistence.loadBranch) {
              const newHistory = persistence.loadBranch();
              setHistory(newHistory);
              setLines(historyToDisplayLines(newHistory));
            }
            setLines(prev => [...prev, { kind: "assistant", text: `Branched to message ${messageId}${withSummary ? " with summary" : ""}.` }]);
          } catch (error) {
            setLines(prev => [...prev, { kind: "error", text: `Branch failed: ${error instanceof Error ? error.message : String(error)}` }]);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (command === "/fork") {
          if (!persistence.fork) {
            setLines(prev => [...prev, { kind: "error", text: "Forking not available (no persistence)." }]);
            return;
          }
          try {
            const result = persistence.fork();
            setHistory(result.messages);
            setLines(prev => [...prev, { kind: "assistant", text: `Forked to new session: ${result.sessionId}` }]);
          } catch (error) {
            setLines(prev => [...prev, { kind: "error", text: `Fork failed: ${error instanceof Error ? error.message : String(error)}` }]);
          }
          return;
        }
        if (command === "/dream") {
          if (!memoryStore) {
            setLines(prev => [...prev, { kind: "error", text: "Dream not available (no memory store in this session)." }]);
            return;
          }
          setBusy(true);
          try {
            setLines(prev => [...prev, { kind: "assistant", text: "Dreaming… reviewing and consolidating memories." }]);
            await runDreamSession(memoryStore, activeSession.devin, activeSession.model, msg => {
              slashOperation.progress({ progressCount: 1 });
              setLines(prev => [...prev, { kind: "assistant", text: msg }]);
            });
            setLines(prev => [...prev, { kind: "assistant", text: "Dream complete. Memories consolidated." }]);
          } catch (error) {
            setLines(prev => [...prev, { kind: "error", text: `Dream failed: ${error instanceof Error ? error.message : String(error)}` }]);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (command === "/cron") {
          setBusy(true);
          try {
            if (!arg) {
              // List all jobs
              const jobs = await loadJobs();
              if (jobs.length === 0) {
                setLines(prev => [...prev, { kind: "assistant", text: "No cron jobs configured. Use /cron add <id> <schedule> <prompt> to create one." }]);
              } else {
                const lines = jobs.map(j => `[${j.id}] ${j.schedule} — ${j.prompt}`).join("\n");
                setLines(prev => [...prev, { kind: "assistant", text: lines }]);
              }
            } else {
              const parts = arg.split(/\s+/);
              const subcommand = parts[0];
              if (subcommand === "add") {
                // /cron add <id> <field1> <field2> <field3> <field4> <field5> <...prompt>
                const id = parts[1];
                const scheduleFields = parts.slice(2, 7);
                const prompt = parts.slice(7).join(" ");
                if (!id || scheduleFields.length < 5 || !prompt) {
                  setLines(prev => [...prev, { kind: "error", text: "Usage: /cron add <id> <cron-schedule> <prompt>  (schedule is 5 fields, e.g. 0 9 * * *)" }]);
                  return;
                }
                const schedule = scheduleFields.join(" ");
                const jobs = await loadJobs();
                if (jobs.some(j => j.id === id)) {
                  setLines(prev => [...prev, { kind: "error", text: `A cron job with id "${id}" already exists.` }]);
                  return;
                }
                const newJob = validateJob({ id, schedule, prompt, lastRun: null }, CRON_PATH);
                await saveJobs([...jobs, newJob]);
                setLines(prev => [...prev, { kind: "assistant", text: `Added cron job "${id}": ${schedule} — ${prompt}` }]);
              } else if (subcommand === "remove") {
                const id = parts[1];
                if (!id) {
                  setLines(prev => [...prev, { kind: "error", text: "Usage: /cron remove <id>" }]);
                  return;
                }
                const jobs = await loadJobs();
                if (!jobs.some(j => j.id === id)) {
                  setLines(prev => [...prev, { kind: "error", text: `No cron job found with id "${id}".` }]);
                  return;
                }
                await saveJobs(jobs.filter(j => j.id !== id));
                setLines(prev => [...prev, { kind: "assistant", text: `Removed cron job "${id}".` }]);
              } else {
                setLines(prev => [...prev, { kind: "error", text: `Unknown /cron subcommand "${subcommand}". Use: /cron, /cron add, /cron remove` }]);
              }
            }
          } catch (error) {
            setLines(prev => [...prev, { kind: "error", text: `Cron error: ${error instanceof CronJobsError ? error.message : error instanceof Error ? error.message : String(error)}` }]);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (command.startsWith("/skill:")) {
          const skillExpansion = expandSkillCommand(text, activeSession.skillIndex ?? new Map());
          if (skillExpansion === null) { return; }
          if (skillExpansion.kind === "error") {
            setLines(prev => [...prev, { kind: "error", text: skillExpansion.message }]);
            return;
          }
          text = skillExpansion.content;
          // Fall through to the agent turn below
        }
      } catch (error) {
        slashOperation.end("failure", error);
        throw error;
      } finally {
        slashOperation.end("success");
      }
    }

    if (extensionRunner) {
      const inputResult = await extensionRunner.emitInput({ type: "input", text, source: "cli" });
      if (inputResult.action === "handled") return;
      if (inputResult.action === "transform") text = inputResult.text ?? text;
    }

    setLines(previous => [...previous, { kind: "user", text }]);
    setBusy(true);
    setStreaming("");
    streamSegmentsRef.current = createStreamSegments();
    setToolLabels(new Map());
    const preTurnTodos = todoStoreRef.current.read();
    const agentSession = createAgentSession({
      devin: activeSession.devin,
      model: activeSession.model.id,
      contextWindow: activeSession.model.contextWindow,
      systemPrompt: activeSession.systemPrompt,
      confirmShellCommand,
      iterationBudget: () => iterationBudgetRef.current,
      todoStore: todoStoreRef.current,
      clarifyCallback,
      commandApprovalMode: approvalMode,
      operationTimeoutMs,
      sessionApprovals: sessionApprovalsRef.current,
      ...(reviewerModel !== undefined ? { reviewerModel } : {}),
      ...(extensionRunner ? { extensionRunner } : {}),
      ...(memoryStore ? { memoryStore } : {}),
      ...(noteStore ? { noteStore } : {}),
      ...(activeMoaPreset !== null ? { moaPreset: activeMoaPreset } : {}),
      ...(advisorModel ? { advisor: { model: advisorModel } } : {}),
    });
    const diagnosticBridge = createAgentDiagnosticsBridge(diagnostics.observer, {
      model: activeSession.model.id,
      ...(persistence.sessionMetadata ? { sessionId: persistence.sessionMetadata.id } : {}),
    });
    let sawInitialUserMessage = false;
    const unsubscribe = agentSession.subscribe(event => {
      diagnosticBridge.handle(event);
      if (event.type === "message_update" && event.streamEvent.type === "text_delta") {
        const next = appendStreamDelta(streamSegmentsRef.current, event.streamEvent.delta);
        streamSegmentsRef.current = next;
        setStreaming(next.segment);
      } else if (event.type === "tool_execution_start") {
        onToolExecutionStart(event.toolCallId, event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        onToolExecutionEnd(event.toolCallId, event.toolName, event.result);
      } else if (event.type === "compaction_end") {
        setLines(previous => [...previous, { kind: "assistant", text: COMPACTION_ACK_MESSAGE }]);
      } else if (event.type === "moa_reference_start") {
        setLines(previous => [...previous, { kind: "assistant", text: `⟐ MoA reference ${event.index + 1}/${event.count} (${event.model})...` }]);
      } else if (event.type === "moa_reference_end") {
        const summary = event.text.startsWith("[failed:")
          ? "[failed]"
          : event.text.slice(0, 80);
        setLines(previous => {
          const updated = [...previous];
          const last = updated.at(-1);
          if (last !== undefined && last.kind === "assistant" && last.text.startsWith(`⟐ MoA reference ${event.index + 1}/`)) {
            updated[updated.length - 1] = { kind: "assistant", text: `⟐ MoA reference ${event.index + 1} (${event.model}): ${summary}` };
          }
          return updated;
        });
      } else if (event.type === "moa_aggregating") {
        setLines(previous => [...previous, { kind: "assistant", text: `⟐ Aggregating from ${event.refCount} reference${event.refCount === 1 ? "" : "s"}...` }]);
      } else if (event.type === "message_start" && event.message.role === "user") {
        if (!sawInitialUserMessage) {
          sawInitialUserMessage = true;
        } else if (typeof event.message.content === "string") {
          const userText = event.message.content;
          const advisory = parseAdvisoryMessage(userText);
          flushStreamingLine();
          setQueuedSteer(false);
          setLines(previous => [...previous, advisory ? { kind: "advisory", ...advisory } : { kind: "user", text: userText }]);
        }
      }
    });
    activeAgentRef.current = agentSession;
    const outcome = await agentSession.run({ history, text });
    activeAgentRef.current = null;
    unsubscribe();

    if (outcome.ok) {
      diagnosticBridge.complete();
      const completedTodos = todoStoreRef.current.read();
      setHistory(outcome.messages);
      setTodos(completedTodos);
      const finalSegment = finishStreamSegments(outcome.assistantText, streamSegmentsRef.current);
      if (finalSegment !== "") setLines(previous => [...previous, { kind: "assistant", text: finalSegment }]);
      if (persistence.checkpoint) {
        const checkpoint = attemptCheckpoint(persistence.checkpoint, outcome.messages, completedTodos, checkpointUnsaved);
        setCheckpointUnsaved(checkpoint.unsaved);
        if (checkpoint.error) {
          diagnostics.observer.event({ event: "checkpoint_failure", severity: "error", outcome: "failure", errorClass: "CheckpointError", errorMessage: checkpoint.error });
          setLines(previous => [...previous, { kind: "error", text: `Session checkpoint was not saved (${checkpoint.error}). The completed turn is retained and will be retried.` }]);
        } else if (checkpoint.recovered) {
          diagnostics.observer.event({ event: "checkpoint_recovery", outcome: "recovery" });
          setLines(previous => [...previous, { kind: "assistant", text: "Session checkpoint recovered." }]);
        }
      }
    } else if ("aborted" in outcome) {
      diagnosticBridge.abort();
      setHistory(outcome.messages);
      setTodos(todoStoreRef.current.read());
      const interruptedSegment = finishStreamSegments(outcome.assistantText, streamSegmentsRef.current);
      if (interruptedSegment !== "") setLines(previous => [...previous, { kind: "assistant", text: interruptedSegment }]);
      setLines(previous => [...previous, { kind: "assistant", text: `Stopped by user${outcome.cancelledQueued > 0 ? ` · cancelled ${outcome.cancelledQueued} queued message${outcome.cancelledQueued === 1 ? "" : "s"}` : ""}.` }]);
    } else {
      diagnosticBridge.fail(outcome.error);
      todoStoreRef.current = createHydratedTodoStore(preTurnTodos);
      setTodos(preTurnTodos);
      setLines(previous => [...previous, { kind: "error", text: describeDevinError(outcome.error) ?? String(outcome.error) }]);
    }
    setStreaming("");
    setBusy(false);
    setTodoLoading(false);
    setQueuedSteer(false);
  }, [activeMoaPreset, activeSession, busy, checkpointUnsaved, clarifyCallback, confirmShellCommand, diagnostics, exit, extensionRunner, flushStreamingLine, history, onToolExecutionEnd, onToolExecutionStart, pendingClarify, pendingCommand, persistence, stdoutWrite]);

  const useComposerInput = (handler: (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => void, isActive: boolean): void => {
    useInput((input, key) => {
      if (!shouldHandleComposerEvent(key.eventType)) return;
      const sanitizedInput = sanitizeComposerInput(input);
      if (sanitizedInput === "" && input !== "") return;
      if (key.ctrl && sanitizedInput.toLowerCase() === "u") {
        setDraft("");
        setComposerRevision(revision => revision + 1);
        setCompletionMatches([]);
        setCompletionIndex(null);
        return;
      }
      if (key.tab) { completeSuggestion(); return; }
      handler(sanitizedInput, key);
    }, { isActive });
  };

  const visibleRows = visibleViewportRows(physicalTranscriptRows, viewport);
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header theme={theme} />
      <Box
        flexDirection="column"
        flexGrow={1}
        height={transcriptRows}
        overflow="hidden"
        paddingX={1}
        justifyContent={transcriptJustification(visibleRows.length, viewport.unseen > 0, viewport.viewportRows)}
      >
        {visibleRows.map((row, index) => <TranscriptRowLine key={`${viewport.offset + index}-${row.kind}`} row={row} theme={theme} />)}
        {viewport.unseen > 0 && <Text color={theme.warning}>↓ {viewport.unseen} unseen output row{viewport.unseen === 1 ? "" : "s"} · End to follow</Text>}
      </Box>
      <TodoPanel todos={todos} isLoading={todoLoading} theme={theme} />
      {pendingCommand !== null && (
        <Box backgroundColor={theme.warningSurface} paddingX={1}><Text color={approvalColor(theme)}>APPROVAL · Run shell command: {pendingCommand} [y/n]</Text></Box>
      )}
      {pendingClarify !== null && (
        <Box flexDirection="column" backgroundColor={theme.warningSurface} paddingX={1}>
          <Text color={approvalColor(theme)}>❓ {pendingClarify.question}</Text>
          {pendingClarify.choices?.map((c, i) => <Text key={i} color={i === clarifySelector.selectedIndex ? theme.accent : approvalColor(theme)}>{i === clarifySelector.selectedIndex ? "›" : " "} {c}</Text>)}
          <Text color={theme.dim}>{pendingClarify.choices ? "↑/↓ select · Enter answer · Esc skip" : "Type your answer and press Enter, or Esc to skip"}</Text>
        </Box>
      )}
      {queuedSteer && <Text color={theme.warning}>Queued · steering will apply at the next boundary</Text>}
      {(completionMatches.length > 1 || liveMatches.length > 0) && (
        <Suggestions items={completionMatches.length > 1 ? completionMatches : liveMatches} selectedIndex={completionIndex ?? -1} theme={theme} />
      )}
      {modelPicker !== null && (() => {
        const window = selectionListWindow(modelPicker.selectedIndex, modelPicker.models.length, pickerVisibleCount);
        return (
          <Box flexDirection="column">
            <Text color={theme.dim}> ↑/↓ select · Enter switch{modelPicker.sessionOnly ? " (session only)" : " and save"} · Esc cancel</Text>
            {modelPicker.models.slice(window.start, window.end).map((model, visibleIndex) => (
              <ModelRow key={model.id} model={model} selected={window.start + visibleIndex === modelPicker.selectedIndex} theme={theme} columns={columns} />
            ))}
          </Box>
        );
      })()}
      {pendingTrust && (
        <Selector title={`Trust project folder ${cwd ?? process.cwd()}?`} items={TRUST_CHOICES.map(choice => ({ id: choice.value, label: choice.label }))} state={trustSelector} theme={theme} />
      )}
      {actionPicker && <Selector title={actionPicker.title} items={actionPicker.items} state={actionPicker.selector} theme={theme} />}
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} height={composerHeight + 2}>
        <Text color={theme.accent}>❯ </Text>
        <MultilineInput
          key={composerRevision}
          value={draft}
          onChange={value => { setDraft(value); setCompletionMatches([]); setCompletionIndex(null); }}
          onSubmit={value => { void handleSubmit(value); }}
          rows={composerHeight}
          maxRows={composerHeight}
           focus={pendingCommand === null && modelPicker === null && actionPicker === null && !(pendingClarify?.choices && pendingClarify.choices.length > 0) && !pendingTrust}
           placeholder={busy ? (pendingClarify ? "Type your answer…" : "Steer the active run…") : pendingCommand ? "Awaiting approval…" : modelPicker ? "Selecting model…" : pendingTrust ? "Choosing trust…" : "Message Railgun"}
          textStyle={{ color: theme.text }}
          highlightStyle={{ color: theme.text }}
          keyBindings={{
            submit: key => key.return && !key.shift,
            newline: key => key.return && key.shift,
          }}
          useCustomInput={useComposerInput}
        />
      </Box>
      <StatusBar theme={theme} session={activeSession} gitStatus={gitStatus} {...(persistence.sessionMetadata ? { metadata: persistence.sessionMetadata } : {})} unsaved={checkpointUnsaved} viewportOffset={viewport.offset} viewportRows={viewport.viewportRows} totalRows={viewport.totalRows} activeMoaPreset={activeMoaPreset} diagnosticStatus={diagnosticStatus} now={diagnosticNow} />
    </Box>
  );
};

export const runRepl = async (
  session: DevinSession,
  persistence?: ReplPersistenceOptions,
  extensionRunner?: ExtensionRunner,
  trustDecision?: TrustDecision,
  trustStore?: ProjectTrustStore,
  memoryStore?: MemoryStore,
  noteStore?: NoteStore,
  diagnostics?: InteractiveDiagnostics,
): Promise<void> => {
  const themeController = new ThemeController();
  const initialMode = await themeController.start();
  const screenReaderEnabled = process.env["INK_SCREEN_READER"] === "true";
  const useAlternateScreen = shouldUseAlternateScreen(process.stdout.isTTY === true, screenReaderEnabled);
  try {
    diagnostics?.observer.event({ event: "terminal_setup", terminalColumns: process.stdout.columns, terminalRows: process.stdout.rows, outcome: "start" });
    await runInAlternateScreen(sequence => process.stdout.write(sequence), useAlternateScreen, () =>
      runWithMouseTracking(sequence => process.stdout.write(sequence), useAlternateScreen, async () => {
        const cwd = process.cwd();
        const instance = render(
          <ChatApp
            session={session}
            initialMode={initialMode}
            themeController={themeController}
            {...(persistence ? { persistence } : {})}
            {...(extensionRunner ? { extensionRunner } : {})}
            {...(trustDecision !== undefined ? { initialTrustDecision: trustDecision } : {})}
            {...(trustStore !== undefined ? { trustStore, cwd } : {})}
            {...(memoryStore !== undefined ? { memoryStore } : {})}
            {...(noteStore !== undefined ? { noteStore } : {})}
            {...(diagnostics !== undefined ? { diagnostics } : {})}
          />,
          {
            exitOnCtrlC: false,
            isScreenReaderEnabled: screenReaderEnabled,
            kittyKeyboard: { mode: enhancedKeyboardMode(process.env), flags: ["disambiguateEscapeCodes"] },
          },
        );
        await instance.waitUntilExit();
      }),
    );
  } finally {
    diagnostics?.observer.event({ event: "terminal_shutdown", outcome: "success" });
    await themeController.dispose();
  }
};
