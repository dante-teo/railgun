const TOOL_KIND_MAP: Record<string, string> = {
  readFile: "read",
  listDirectory: "read",
  skillView: "read",
  writeFile: "edit",
  runShell: "execute",
  todo: "think",
  clarify: "other",
  memory: "other",
  advise: "other",
};

export const mapToolKind = (toolName: string): string =>
  TOOL_KIND_MAP[toolName] ?? "other";
