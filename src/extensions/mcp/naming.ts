export const sanitizeForToolName = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

export const makeUniquePrefixedName = (
  serverName: string,
  toolName: string,
  seen: Set<string>,
): string => {
  const base = `mcp__${sanitizeForToolName(serverName)}__${sanitizeForToolName(toolName)}`;
  let candidate = base;
  let counter = 1;
  while (seen.has(candidate)) candidate = `${base}_${counter++}`;
  seen.add(candidate);
  return candidate;
};
