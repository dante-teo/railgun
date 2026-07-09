import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanForThreats } from "../security/threatPatterns.js";

export interface ProjectContextCandidate {
  readonly names: readonly string[];
  readonly walkToGitRoot: boolean;
}

export const PROJECT_CONTEXT_CANDIDATES: readonly ProjectContextCandidate[] = [
  { names: [".railgun.md", "RAILGUN.md"], walkToGitRoot: true },
  { names: ["AGENTS.md", "agents.md"], walkToGitRoot: false },
  { names: ["CLAUDE.md", "claude.md"], walkToGitRoot: false },
  { names: [".cursorrules"], walkToGitRoot: false },
];

export const SOUL_PATH = join(homedir(), ".railgun", "SOUL.md");

// ── Internal helpers ─────────────────────────────────────────────────────

interface FoundFile {
  readonly path: string;
  readonly name: string;
  readonly content: string;
}

const hasGitEntry = async (dir: string): Promise<boolean> => {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

const findGitRoot = async (startDir: string): Promise<string | undefined> => {
  let dir = resolve(startDir);
  for (;;) {
    if (await hasGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const findFileInDir = async (dir: string, names: readonly string[]): Promise<FoundFile | undefined> => {
  for (const name of names) {
    try {
      const filePath = join(dir, name);
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      const content = await readFile(filePath, "utf-8");
      if (content.trim().length === 0) continue;
      return { path: filePath, name, content };
    } catch {
      // File doesn't exist or unreadable — try next name
    }
  }
  return undefined;
};

const findUpToGitRoot = async (cwd: string, names: readonly string[]): Promise<FoundFile | undefined> => {
  const resolved = resolve(cwd);
  const gitRoot = await findGitRoot(resolved);
  if (gitRoot === undefined) {
    // No git root → check cwd only
    return findFileInDir(resolved, names);
  }
  // Walk from cwd up to (and including) git root
  let dir = resolved;
  for (;;) {
    const found = await findFileInDir(dir, names);
    if (found) return found;
    if (dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
};


// ── Public API ───────────────────────────────────────────────────────────

const formatBlocked = (filename: string, findings: readonly string[]): string => {
  console.error(`[BLOCKED] ${filename}: prompt injection detected (${findings.join(", ")})`);
  return `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
};

export const scanForInjection = (content: string, filename: string): string => {
  const findings = scanForThreats(content);
  return findings.length > 0 ? formatBlocked(filename, findings) : content;
};

interface PromptWindow {
  readonly text: string;
  readonly truncated: boolean;
  readonly headLen: number;
  readonly tailLen: number;
  readonly originalLen: number;
}

const selectPromptWindow = (content: string, maxChars = 20_000): PromptWindow => {
  if (content.length <= maxChars) return { text: content, truncated: false, headLen: content.length, tailLen: 0, originalLen: content.length };
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.floor(maxChars * 0.3);
  const head = content.slice(0, headLen);
  const tail = content.slice(-tailLen);
  return { text: head + tail, truncated: true, headLen, tailLen, originalLen: content.length };
};

const formatPromptWindow = (window: PromptWindow, filePath: string): string => {
  if (!window.truncated) return window.text;
  const head = window.text.slice(0, window.headLen);
  const tail = window.text.slice(window.headLen);
  return `${head}\n\n[...truncated: kept ${window.headLen}+${window.tailLen} of ${window.originalLen} chars. Read the full file with your file tool if needed: ${filePath}]\n\n${tail}`;
};

export const truncateForPrompt = (content: string, filePath: string, maxChars = 20_000): string =>
  formatPromptWindow(selectPromptWindow(content, maxChars), filePath);

/** Truncate to prompt window, scan head and tail separately for injection, then format. */
const scanAndTruncate = (raw: string, filename: string, filePath: string): string => {
  const window = selectPromptWindow(raw);
  if (!window.truncated) {
    // No truncation — scan the whole content as one piece
    return scanForInjection(window.text, filename);
  }
  // Scan head and tail independently to avoid false positives across the seam
  const head = window.text.slice(0, window.headLen);
  const tail = window.text.slice(window.headLen);
  const headFindings = scanForThreats(head);
  const tailFindings = scanForThreats(tail);
  const allFindings = [...new Set([...headFindings, ...tailFindings])];
  if (allFindings.length > 0) return formatBlocked(filename, allFindings);
  return formatPromptWindow(window, filePath);
};

export const loadProjectContext = async (cwd: string): Promise<string | null> => {
  for (const candidate of PROJECT_CONTEXT_CANDIDATES) {
    const found = candidate.walkToGitRoot
      ? await findUpToGitRoot(cwd, candidate.names)
      : await findFileInDir(resolve(cwd), candidate.names);
    if (!found) continue;
    return scanAndTruncate(found.content, found.name, found.path);
  }
  return null;
};

export const loadSoulIdentity = async (): Promise<string | null> => {
  try {
    const raw = await readFile(SOUL_PATH, "utf-8");
    if (raw.trim().length === 0) return null;
    return scanAndTruncate(raw, "SOUL.md", SOUL_PATH);
  } catch {
    return null;
  }
};
