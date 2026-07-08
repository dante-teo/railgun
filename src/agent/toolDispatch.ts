import { resolve, sep } from "node:path";

export const NEVER_PARALLEL_TOOLS: Record<string, true> = { clarify: true }; // "clarify" doesn't exist until Phase 16; pre-declaring is harmless and avoids editing this file again then.
export const PARALLEL_SAFE_TOOLS: Record<string, true> = { read_file: true }; // only tools that exist today AND are read-only with no shared state; extend as later phases add search_files/web_search/etc.
export const PATH_SCOPED_TOOLS: Record<string, true> = { read_file: true, write_file: true };

export const pathsOverlap = (a: string, b: string): boolean => {
  const aParts = resolve(a).split(sep);
  const bParts = resolve(b).split(sep);
  const n = Math.min(aParts.length, bParts.length);
  return aParts.slice(0, n).join("/") === bParts.slice(0, n).join("/");
};

export const shouldParallelizeToolBatch = (
  calls: readonly { name: string; arguments: unknown }[]
): boolean => {
  if (calls.length <= 1) return false;
  if (calls.some(c => NEVER_PARALLEL_TOOLS[c.name])) return false;

  const reservedPaths: string[] = [];
  for (const call of calls) {
    if (PATH_SCOPED_TOOLS[call.name]) {
      const target =
        typeof call.arguments === "object" && call.arguments !== null && typeof (call.arguments as Record<string, unknown>).path === "string"
          ? ((call.arguments as Record<string, unknown>).path as string)
          : undefined;
      if (target === undefined || !target.trim()) return false;
      if (reservedPaths.some(p => pathsOverlap(p, target))) return false;
      reservedPaths.push(target);
      continue;
    }
    if (!PARALLEL_SAFE_TOOLS[call.name]) return false;
  }
  return true;
};

export const CORRUPTION_MARKER =
  "[railgun: tool call arguments were corrupted and have been dropped. Please retry the tool call.]";

export const safeParseToolArgs = (raw: string): { ok: true; args: unknown } | { ok: false } => {
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};
