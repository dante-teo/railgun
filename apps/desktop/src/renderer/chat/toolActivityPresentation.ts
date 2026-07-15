import type { ActivityStatus } from "./activityState";

export type ToolActivityIcon = "file-edit" | "file-read" | "folder" | "terminal" | "search" | "globe" | "tool";

interface ToolPresentationDefinition {
  readonly running: string;
  readonly completed: string;
  readonly verb: string;
  readonly pluralTarget: string;
  readonly targetKeys: readonly string[];
  readonly icon: ToolActivityIcon;
}

export interface ToolActivityPresentation {
  readonly action: string;
  readonly target?: string;
  readonly icon: ToolActivityIcon;
}

const toolPresentations: Readonly<Record<string, ToolPresentationDefinition>> = {
  write_file: { running: "Editing", completed: "Edited", verb: "edit", pluralTarget: "files", targetKeys: ["path"], icon: "file-edit" },
  read_file: { running: "Reading", completed: "Read", verb: "read", pluralTarget: "files", targetKeys: ["path"], icon: "file-read" },
  list_directory: { running: "Listing", completed: "Listed", verb: "list", pluralTarget: "directories", targetKeys: ["path"], icon: "folder" },
  run_shell: { running: "Running", completed: "Ran", verb: "run", pluralTarget: "commands", targetKeys: ["command"], icon: "terminal" },
  run_shell_command: { running: "Running", completed: "Ran", verb: "run", pluralTarget: "commands", targetKeys: ["command"], icon: "terminal" },
  web_search: { running: "Searching", completed: "Searched", verb: "search", pluralTarget: "web", targetKeys: ["query"], icon: "search" },
  search_files: { running: "Searching", completed: "Searched", verb: "search", pluralTarget: "files", targetKeys: ["query", "path"], icon: "search" },
  web_fetch: { running: "Fetching", completed: "Fetched", verb: "fetch", pluralTarget: "resources", targetKeys: ["url"], icon: "globe" },
  delegate_task: { running: "Delegating", completed: "Delegated", verb: "delegate", pluralTarget: "tasks", targetKeys: ["goal"], icon: "tool" },
  skill_view: { running: "Loading", completed: "Loaded", verb: "load", pluralTarget: "skills", targetKeys: ["name"], icon: "tool" },
  note_search: { running: "Searching", completed: "Searched", verb: "search", pluralTarget: "notes", targetKeys: ["query"], icon: "search" },
  note_write: { running: "Writing", completed: "Wrote", verb: "write", pluralTarget: "notes", targetKeys: ["title"], icon: "file-edit" },
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

const actionForStatus = (definition: ToolPresentationDefinition, status: ActivityStatus): string =>
  status === "running" ? definition.running
    : status === "error" ? `Failed to ${definition.verb}`
      : status === "interrupted" ? `Stopped ${definition.running.toLocaleLowerCase()}`
        : definition.completed;

const actionForUnknownTool = (name: string, status: ActivityStatus): string => {
  const toolName = humanizeToolName(name);
  return status === "running" ? `Running ${toolName}`
    : status === "error" ? `Failed to run ${toolName}`
      : status === "interrupted" ? `Stopped ${toolName}`
        : `Ran ${toolName}`;
};

export const presentToolActivity = (
  name: string,
  input: string | undefined,
  status: ActivityStatus,
  restoredTarget?: string,
): ToolActivityPresentation => {
  const definition = toolPresentations[name];
  if (definition === undefined) {
    return {
      action: actionForUnknownTool(name, status),
      icon: "tool",
      ...(restoredTarget === undefined ? {} : { target: restoredTarget }),
    };
  }
  const action = actionForStatus(definition, status);
  const target = restoredTarget ?? targetFromInput(definition, input);
  return { action, ...(target === undefined ? {} : { target }), icon: definition.icon };
};

export const presentGroupedToolActivity = (name: string, status: ActivityStatus): Omit<ToolActivityPresentation, "target"> => {
  const definition = toolPresentations[name];
  if (definition === undefined) {
    return { action: actionForUnknownTool(name, status), icon: "tool" };
  }
  return { action: `${actionForStatus(definition, status)} ${definition.pluralTarget}`, icon: definition.icon };
};
