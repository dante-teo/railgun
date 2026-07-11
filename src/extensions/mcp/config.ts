import type { McpServerConfig } from "./connection.js";

// Type guard — allowed tiny function (preserves narrowing)
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string";

export const parseMcpServers = (
  raw: unknown,
): Record<string, McpServerConfig> => {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    if (typeof value["command"] !== "string") continue;
    const argsRaw = value["args"];
    const envRaw = value["env"];

    // Build args only when present (exactOptionalPropertyTypes: true forbids `undefined` assignment)
    const args: readonly string[] | undefined = Array.isArray(argsRaw)
      ? argsRaw.filter(isString)
      : undefined;

    // Build env only when present
    let env: Record<string, string> | undefined;
    if (isPlainObject(envRaw)) {
      env = {};
      for (const [k, v] of Object.entries(envRaw)) {
        if (isString(v)) env[k] = v;
      }
    }

    result[name] = {
      command: value["command"],
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
    };
  }
  return result;
};
