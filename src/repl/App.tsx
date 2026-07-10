import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { DevinContentPart, DevinMessage } from "widevin";
import { runTurn } from "../agent/turn.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { describeDevinError } from "../errors.js";
import { buildToolLabel } from "../tools/toolLabel.js";
import { createTodoStore, summarizeTodos } from "../tools/todo.js";
import type { NormalizedTodoItem, TodoState, TodoStore } from "../tools/todo.js";
import type { DevinSession } from "../session.js";
import { BUILTIN_SKINS, DEFAULT_SKIN, resolveSkin } from "../skins.js";
import type { SkinConfig } from "../skins.js";
import { loadConfig, saveConfig } from "../config.js";
import { findMatches, nextCompletionState, parseSlashCommand } from "../commands.js";
import { printBanner } from "./Banner.js";
import { toolLineIcon, toolLineColor, busyColor, busySpinnerType, approvalColor, toolFrameBg, toolFrameBorder } from "./toolLineStyle.js";
import type { ToolFrameState } from "./toolLineStyle.js";
import { Suggestions } from "./Suggestions.js";
import { getGitStatus, formatCwd } from "./statusLine.js";
import type { GitStatus } from "./statusLine.js";

export interface DisplayLine {
  kind: "user" | "assistant" | "error" | "tool";
  text: string;
  failed?: boolean;
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

const assistantContentText = (message: Extract<DevinMessage, { role: "assistant" }>): string =>
  message.content.filter(part => part.type === "text").map(part => part.text).join("");

export const historyToDisplayLines = (history: readonly DevinMessage[]): readonly DisplayLine[] => {
  const groups = history.reduce<Array<{ user: string; assistant: string }>>((turns, message) => {
    if (isUserMessage(message)) return [...turns, { user: userContentText(message), assistant: "" }];
    if (message.role !== "assistant" || turns.length === 0) return turns;
    const text = assistantContentText(message);
    if (text === "") return turns;
    const prior = turns.at(-1)!;
    return [...turns.slice(0, -1), { ...prior, assistant: prior.assistant + text }];
  }, []);
  return groups.flatMap(({ user, assistant }) => [
    { kind: "user" as const, text: user },
    ...(assistant === "" ? [] : [{ kind: "assistant" as const, text: assistant }]),
  ]);
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

export const TodoPanel = ({ todos, isLoading, skin }: { todos: TodoState; isLoading: boolean; skin: SkinConfig }): React.ReactElement | null => {
  if (todos.length === 0 && !isLoading) return null;
  const summary = summarizeTodos(todos);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={skin.colors.border} paddingX={1} marginBottom={1}>
      <Text bold>
        Todos · {summary.completed}/{summary.total}
      </Text>
      {isLoading && todos.length === 0 && (
        <Text color={skin.colors.accent}>
          <Spinner type="dots" /> Crafting todos
        </Text>
      )}
      {todos.map(todo => (
        <Box key={todo.id}>
          <Text color={todo.status === "completed" ? skin.colors.success : todo.status === "in_progress" ? skin.colors.accent : skin.colors.dim}>
            {todoGlyph(todo.status)}{" "}
          </Text>
          <Text>{todo.content}</Text>
        </Box>
      ))}
    </Box>
  );
};

export const shouldAppendToolTranscriptLine = (name: string): boolean => name !== "todo";
export const shouldShowToolLine = (name: string, isError: boolean): boolean => shouldAppendToolTranscriptLine(name) || isError;

const ChatApp = ({
  session,
  initialSkin,
  persistence = {},
}: {
  session: DevinSession;
  initialSkin: SkinConfig;
  persistence?: ReplPersistenceOptions;
}): React.ReactElement => {
  const { exit } = useApp();
  const { write: stdoutWrite } = useStdout();
  const [activeSkin, setActiveSkin] = useState<SkinConfig>(initialSkin);
  const [history, setHistory] = useState<readonly DevinMessage[]>(persistence.initialHistory ?? []);
  const [lines, setLines] = useState<readonly DisplayLine[]>(() => historyToDisplayLines(persistence.initialHistory ?? []));
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [completionIndex, setCompletionIndex] = useState<number | null>(null);
  const [completionMatches, setCompletionMatches] = useState<readonly string[]>([]);
  const liveMatches = useMemo(
    () => (input.startsWith("/") && !input.includes(" ") ? findMatches(input) : []),
    [input],
  );
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const iterationBudgetRef = useRef(IterationBudget.create());
  const todoStoreRef = useRef<TodoStore>(createHydratedTodoStore(persistence.initialTodos ?? []));
  const [todos, setTodos] = useState<TodoState>(todoStoreRef.current.read());
  const [checkpointUnsaved, setCheckpointUnsaved] = useState(false);
  const [todoLoading, setTodoLoading] = useState(false);
  const pendingApprovalRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus>({ branch: null, dirty: false });
  useEffect(() => { getGitStatus(process.cwd()).then(setGitStatus); }, []);

  const confirmShellCommand = useCallback((command: string): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    pendingApprovalRef.current = { resolve };
    setPendingCommand(command);
    return promise;
  }, []);

  useInput(
    (input, key) => {
      const pending = pendingApprovalRef.current;
      if (!pending) return;
      if (input.toLowerCase() === "y") {
        pending.resolve(true);
      } else if (input.toLowerCase() === "n" || key.escape) {
        pending.resolve(false);
      } else {
        return;
      }
      pendingApprovalRef.current = null;
      setPendingCommand(null);
    },
    { isActive: pendingCommand !== null }
  );

  useInput(
    (_ch, key) => {
      if (key.tab || (key.escape && completionMatches.length > 0)) {
        const event = key.tab ? "tab" as const : "escape" as const;
        const next = nextCompletionState(completionMatches, completionIndex, liveMatches, event);
        setCompletionMatches(next.frozenMatches);
        setCompletionIndex(next.index);
        if (next.input !== null) {
          setInput(next.input);
          setInputKey(k => k + 1);
        }
      }
    },
    { isActive: !busy && pendingCommand === null }
  );

  const onToolStart = useCallback((name: string, args: unknown) => {
    if (name === "todo") setTodoLoading(true);
    setToolLabel(buildToolLabel(name, args, "start"));
  }, []);

  const onToolComplete = useCallback((name: string, args: unknown, isError: boolean) => {
    setToolLabel(null);
    if (!shouldAppendToolTranscriptLine(name)) {
      setTodoLoading(false);
      setTodos(todoStoreRef.current.read());
    }
    if (shouldShowToolLine(name, isError)) {
      setLines(prev => [...prev, { kind: "tool", text: buildToolLabel(name, args, "complete"), failed: isError }]);
    }
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      setCompletionIndex(null);
      setCompletionMatches([]);
      if (text === "") return;
      if (text.startsWith("/")) {
        const { command, arg } = parseSlashCommand(text);
        switch (command) {
          case "/exit":
            exit();
            return;
          case "/skin": {
            const resolved = arg ? resolveSkin(arg) : undefined;
            if (resolved) {
              setActiveSkin(resolved);
              setLines(prev => [...prev, {
                kind: "assistant",
                text: `Skin changed to "${resolved.name}".`,
              }]);
              saveConfig({ skin: resolved.name }).catch(() => {});
            } else {
              setLines(prev => [...prev, {
                kind: "error",
                text: `Unknown skin: ${arg ?? "(none)"}. Available: ${Object.keys(BUILTIN_SKINS).join(", ")}.`,
              }]);
            }
            return;
          }
          case "/help":
            setLines(prev => [...prev, {
              kind: "assistant",
              text: "Commands: /exit, /skin <name>, /help, /clear",
            }]);
            return;
          case "/clear":
            stdoutWrite("\x1Bc");
            return;
        }
      }

      setLines(prev => [...prev, { kind: "user", text }]);
      setBusy(true);
      setStreaming("");
      setToolLabel(null);
      const preTurnTodos = todoStoreRef.current.read();

      const outcome = await runTurn(
        session.devin,
        session.model.id,
        session.systemPrompt,
        history,
        text,
        iterationBudgetRef.current,
        confirmShellCommand,
        {
          onDelta: delta => {
            setStreaming(prev => prev + delta);
          },
          onToolStart,
          onToolComplete
        },
        { todoStore: todoStoreRef.current }
      );

      if (outcome.ok) {
        const completedTodos = todoStoreRef.current.read();
        setHistory(outcome.messages);
        setTodos(completedTodos);
        if (outcome.assistantText !== "") setLines(prev => [...prev, { kind: "assistant", text: outcome.assistantText }]);
        if (persistence.checkpoint) {
          const checkpoint = attemptCheckpoint(
            persistence.checkpoint,
            outcome.messages,
            completedTodos,
            checkpointUnsaved,
          );
          setCheckpointUnsaved(checkpoint.unsaved);
          if (checkpoint.error) {
            setLines(prev => [...prev, {
              kind: "error",
              text: `Session checkpoint was not saved (${checkpoint.error}). The completed turn is retained and will be retried.`,
            }]);
          } else if (checkpoint.recovered) {
            setLines(prev => [...prev, { kind: "assistant", text: "Session checkpoint recovered." }]);
          }
        }
      } else {
        todoStoreRef.current = createHydratedTodoStore(preTurnTodos);
        setTodos(preTurnTodos);
        const message = describeDevinError(outcome.error) ?? String(outcome.error);
        setLines(prev => [...prev, { kind: "error", text: message }]);
      }

      setStreaming("");
      setBusy(false);
      setTodoLoading(false);
    },
    [history, session, persistence, checkpointUnsaved, exit, stdoutWrite, confirmShellCommand, onToolStart, onToolComplete]
  );

  return (
    <Box flexDirection="column">
      <Static items={[...lines]}>
        {(line, index) => {
          if (line.kind === "tool") {
            const state: ToolFrameState = line.failed ? "error" : "success";
            return (
              <Box key={index} borderStyle="round" borderColor={toolFrameBorder(activeSkin, state)} backgroundColor={toolFrameBg(activeSkin, state)} paddingX={1}>
                <Text color={toolLineColor(activeSkin, !!line.failed)}>
                  {toolLineIcon(!!line.failed) + " " + line.text}
                </Text>
              </Box>
            );
          }
          if (line.kind === "user") {
            return (
              <Box key={index} backgroundColor={activeSkin.colors.userMessageBg} paddingX={1}>
                <Text>{`${activeSkin.colors.promptSymbol} ${line.text}`}</Text>
              </Box>
            );
          }
          return (
            <Text key={index} {...(line.kind === "error" ? { color: activeSkin.colors.error } : {})}>
              {line.text}
            </Text>
          );
        }}
      </Static>
      {busy && toolLabel !== null && (
        <Box borderStyle="round" borderColor={toolFrameBorder(activeSkin, "pending")} backgroundColor={toolFrameBg(activeSkin, "pending")} paddingX={1}>
          <Text color={busyColor(activeSkin)}><Spinner type={busySpinnerType()} /> {toolLabel}</Text>
        </Box>
      )}
      {busy && toolLabel === null && (
        <Text color={busyColor(activeSkin)}>{streaming || "…"}</Text>
      )}
      {pendingCommand !== null && (
        <Text color={approvalColor(activeSkin)}>Run shell command: {pendingCommand} [y/n]</Text>
      )}
      <TodoPanel todos={todos} isLoading={todoLoading} skin={activeSkin} />
      <Box borderStyle="round" borderColor={activeSkin.colors.border} paddingX={1}>
        <Text>{activeSkin.colors.promptSymbol + " "}</Text>
        <TextInput
          key={inputKey}
          value={input}
          onChange={v => { setInput(v); setCompletionMatches([]); setCompletionIndex(null); }}
          onSubmit={handleSubmit}
          focus={!busy && pendingCommand === null}
        />
      </Box>
      {(completionMatches.length > 1 || liveMatches.length > 0) && (
        <Suggestions
          items={completionMatches.length > 1 ? completionMatches : liveMatches}
          selectedIndex={completionIndex ?? -1}
          skin={activeSkin}
        />
      )}
      <Box backgroundColor={activeSkin.colors.statusLineBg} paddingX={1}>
        <Text color={activeSkin.colors.statusLineModel}>{session.model.id}</Text>
        <Text> · </Text>
        <Text color={activeSkin.colors.statusLinePath}>{formatCwd(process.cwd())}</Text>
        {gitStatus.branch !== null && (
          <>
            <Text> · </Text>
            <Text color={gitStatus.dirty ? activeSkin.colors.statusLineGitDirty : activeSkin.colors.statusLineGitClean}>
              {gitStatus.branch}{gitStatus.dirty ? "*" : ""}
            </Text>
          </>
        )}
        {persistence.sessionMetadata && (
          <>
            <Text> · </Text>
            <Text>{persistence.sessionMetadata.id.slice(0, 8)}</Text>
          </>
        )}
        {checkpointUnsaved && <Text color={activeSkin.colors.error}> · unsaved</Text>}
      </Box>
    </Box>
  );
};

export const runRepl = async (session: DevinSession, persistence?: ReplPersistenceOptions): Promise<void> => {
  const config = await loadConfig();
  const initialSkin = resolveSkin(config.skin) ?? DEFAULT_SKIN;
  printBanner(initialSkin);
  const instance = render(<ChatApp session={session} initialSkin={initialSkin} {...(persistence ? { persistence } : {})} />);
  await instance.waitUntilExit();
};
