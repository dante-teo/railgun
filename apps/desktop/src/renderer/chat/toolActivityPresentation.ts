import type { ActivityStatus } from "./activityState";

export type ToolActivityIcon = "file-edit" | "file-read" | "folder" | "terminal" | "search" | "globe" | "tool";

interface ToolPresentationDefinition {
  readonly running: string;
  readonly completed: string;
  readonly verb: string;
  readonly targetKeys: readonly string[];
  readonly icon: ToolActivityIcon;
}

export interface ToolActivityPresentation {
  readonly action: string;
  readonly target?: string;
  readonly icon: ToolActivityIcon;
}

const toolPresentations: Readonly<Record<string, ToolPresentationDefinition>> = {
  write_file: { running: "Editing", completed: "Edited", verb: "edit", targetKeys: ["path"], icon: "file-edit" },
  read_file: { running: "Reading", completed: "Read", verb: "read", targetKeys: ["path"], icon: "file-read" },
  list_directory: { running: "Listing", completed: "Listed", verb: "list", targetKeys: ["path"], icon: "folder" },
  run_shell: { running: "Running", completed: "Ran", verb: "run", targetKeys: ["command"], icon: "terminal" },
  run_shell_command: { running: "Running", completed: "Ran", verb: "run", targetKeys: ["command"], icon: "terminal" },
  web_search: { running: "Searching", completed: "Searched", verb: "search", targetKeys: ["query"], icon: "search" },
  search_files: { running: "Searching", completed: "Searched", verb: "search", targetKeys: ["query", "path"], icon: "search" },
  web_fetch: { running: "Fetching", completed: "Fetched", verb: "fetch", targetKeys: ["url"], icon: "globe" },
  delegate_task: { running: "Delegating", completed: "Delegated", verb: "delegate", targetKeys: ["goal"], icon: "tool" },
  skill_view: { running: "Loading", completed: "Loaded", verb: "load", targetKeys: ["name"], icon: "tool" },
  note_search: { running: "Searching", completed: "Searched", verb: "search", targetKeys: ["query"], icon: "search" },
  note_write: { running: "Writing", completed: "Wrote", verb: "write", targetKeys: ["title"], icon: "file-edit" },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseInput = (input: string | undefined): Record<string, unknown> | undefined => {
  if (input === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

const filename = (path: string): string => {
  const segments = path.replace(/\\/gu, "/").split("/").filter(Boolean);
  return segments.at(-1) ?? path;
};

const targetFromInput = (definition: ToolPresentationDefinition, input: string | undefined): string | undefined => {
  const parsed = parseInput(input);
  const value = definition.targetKeys
    .map(key => parsed?.[key])
    .find((candidate): candidate is string => typeof candidate === "string" && oneLine(candidate) !== "");
  if (value === undefined) return input === undefined || input.trim().startsWith("{") ? undefined : oneLine(input);
  return definition.targetKeys.includes("path") && definition.targetKeys[0] === "path" ? filename(value) : oneLine(value);
};

const humanizeToolName = (name: string): string => name.replace(/[_-]+/gu, " ");

export const presentToolActivity = (
  name: string,
  input: string | undefined,
  status: ActivityStatus,
  restoredTarget?: string,
): ToolActivityPresentation => {
  const definition = toolPresentations[name];
  if (definition === undefined) {
    const toolName = humanizeToolName(name);
    return {
      action: status === "running" ? `Running ${toolName}` : status === "error" ? `Failed to run ${toolName}` : status === "interrupted" ? `Stopped ${toolName}` : `Ran ${toolName}`,
      icon: "tool",
      ...(restoredTarget === undefined ? {} : { target: restoredTarget }),
    };
  }
  const baseAction = status === "running" ? definition.running : definition.completed;
  const action = status === "error"
    ? `Failed to ${definition.verb}`
    : status === "interrupted"
      ? `Stopped ${definition.running.toLocaleLowerCase()}`
      : baseAction;
  const target = restoredTarget ?? targetFromInput(definition, input);
  return { action, ...(target === undefined ? {} : { target }), icon: definition.icon };
};
