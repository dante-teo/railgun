import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { DevinMessage } from "widevin";
import { runTurn } from "../agent/turn.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { describeDevinError } from "../errors.js";
import { buildToolLabel } from "../tools/toolLabel.js";
import { createTodoStore, deriveTodoProgress, summarizeTodos } from "../tools/todo.js";
import type { NormalizedTodoItem, TodoState, TodoStore } from "../tools/todo.js";
import type { DevinSession } from "../session.js";
import { BUILTIN_SKINS, DEFAULT_SKIN, resolveSkin } from "../skins.js";
import type { SkinConfig } from "../skins.js";
import { loadConfig, saveConfig } from "../config.js";
import { findMatches, nextCompletionState, parseSlashCommand } from "../commands.js";
import { printBanner } from "./Banner.js";
import { Suggestions } from "./Suggestions.js";
import { extractMarkdownTodos, stripMarkdownTodoLines } from "./markdownTodos.js";

interface DisplayLine {
  kind: "user" | "assistant" | "error" | "tool";
  text: string;
  failed?: boolean;
}

const statusMarker = (status: NormalizedTodoItem["status"]): string => {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "cancelled") return "×";
  return "○";
};

const TodoRow = ({ todo, depth = 0 }: { todo: NormalizedTodoItem; depth?: number }): React.ReactElement => {
  const children = todo.children ?? [];
  const progress = deriveTodoProgress(todo);
  const label = children.length > 0 ? `${todo.content} ${progress.done}/${progress.total}` : todo.content;
  return (
    <Box flexDirection="column">
      <Box marginLeft={depth * 2}>
        <Text color={todo.status === "completed" ? "green" : todo.status === "in_progress" ? "cyan" : "gray"}>
          {statusMarker(todo.status)}{" "}
        </Text>
        <Text>{label}</Text>
      </Box>
      {children.map(child => (
        <TodoRow key={child.id} todo={child} depth={depth + 1} />
      ))}
    </Box>
  );
};

export const TodoPanel = ({ todos, isLoading }: { todos: TodoState; isLoading: boolean }): React.ReactElement | null => {
  if (todos.length === 0 && !isLoading) return null;
  const summary = summarizeTodos(todos);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>
        Todos · {summary.completed}/{summary.total}
      </Text>
      {isLoading && todos.length === 0 && (
        <Text color="cyan">
          <Spinner type="dots" /> Crafting todos
        </Text>
      )}
      {todos.map(todo => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </Box>
  );
};

export const shouldAppendToolTranscriptLine = (name: string): boolean => name !== "todo";

const ChatApp = ({ session, initialSkin }: { session: DevinSession; initialSkin: SkinConfig }): React.ReactElement => {
  const { exit } = useApp();
  const { write: stdoutWrite } = useStdout();
  const [activeSkin, setActiveSkin] = useState<SkinConfig>(initialSkin);
  const [history, setHistory] = useState<readonly DevinMessage[]>([]);
  const [lines, setLines] = useState<readonly DisplayLine[]>([]);
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
  const todoStoreRef = useRef<TodoStore>(createTodoStore());
  const [todos, setTodos] = useState<TodoState>(todoStoreRef.current.read());
  const [todoLoading, setTodoLoading] = useState(false);
  const pendingApprovalRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);

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
      return;
    }
    setLines(prev => [...prev, { kind: "tool", text: buildToolLabel(name, args, "complete"), failed: isError }]);
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
        setHistory(outcome.messages);
        const fallbackTodos = extractMarkdownTodos(outcome.assistantText);
        const nextTodos = todoStoreRef.current.read().length === 0 && fallbackTodos.length > 0
          ? todoStoreRef.current.write({ todos: fallbackTodos }).todos
          : todoStoreRef.current.read();
        const displayText = fallbackTodos.length > 0 ? stripMarkdownTodoLines(outcome.assistantText) : outcome.assistantText;
        setTodos(nextTodos);
        if (displayText !== "") setLines(prev => [...prev, { kind: "assistant", text: displayText }]);
      } else {
        const message = describeDevinError(outcome.error) ?? String(outcome.error);
        setLines(prev => [...prev, { kind: "error", text: message }]);
      }

      setStreaming("");
      setBusy(false);
      setTodoLoading(false);
    },
    [history, session, exit, stdoutWrite, confirmShellCommand, onToolStart, onToolComplete]
  );

  return (
    <Box flexDirection="column">
      <Static items={[...lines]}>
        {(line, index) => {
          if (line.kind === "tool") {
            return (
              <Text key={index} color={line.failed ? "red" : "green"}>
                {(line.failed ? "✗ " : "✓ ") + line.text}
              </Text>
            );
          }
          return (
            <Text key={index} {...(line.kind === "error" ? { color: "red" as const } : {})}>
              {line.kind === "user" ? `${activeSkin.colors.promptSymbol} ${line.text}` : line.text}
            </Text>
          );
        }}
      </Static>
      {busy &&
        (toolLabel !== null ? (
          <Text color="cyan">
            <Spinner type={activeSkin.spinnerType} /> {toolLabel}
          </Text>
        ) : (
          <Text color="cyan">{streaming || "…"}</Text>
        ))}
      {pendingCommand !== null && (
        <Text color="yellow">Run shell command: {pendingCommand} [y/n]</Text>
      )}
      <TodoPanel todos={todos} isLoading={todoLoading} />
      <Box>
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
        />
      )}
    </Box>
  );
};

export const runRepl = async (session: DevinSession): Promise<void> => {
  const config = await loadConfig();
  const initialSkin = resolveSkin(config.skin) ?? DEFAULT_SKIN;
  printBanner(initialSkin);
  const instance = render(<ChatApp session={session} initialSkin={initialSkin} />);
  await instance.waitUntilExit();
};
