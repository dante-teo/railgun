import { chmod, lstat, mkdir, open, readdir, rename, stat, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_MS = 7 * DAY_MS;
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const safeFragment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
const fileTimestamp = (date: Date): string => date.toISOString().replace(/[-:.]/g, "");

export interface OpenedDiagnosticLog {
  readonly handle: FileHandle;
  readonly path: string;
  readonly latestPath: string;
}

export const pruneInteractiveLogs = async (
  logDir: string,
  options: { readonly nowMs?: number; readonly retentionMs?: number; readonly maxBytes?: number } = {},
): Promise<void> => {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries = await readdir(logDir, { withFileTypes: true });
  const candidates = (await Promise.all(entries
    .filter(entry => entry.isFile() && /^interactive-.*\.jsonl$/.test(entry.name) && entry.name !== "interactive-latest.jsonl")
    .map(async entry => ({ path: join(logDir, entry.name), ...(await stat(join(logDir, entry.name))) }))))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const retained = candidates.filter(file => nowMs - file.mtimeMs <= retentionMs);
  await Promise.all(candidates.filter(file => nowMs - file.mtimeMs > retentionMs).map(file => unlink(file.path)));
  const total = retained.reduce((bytes, file) => bytes + file.size, 0);
  const overageCount = retained.reduce(
    (result, file, index) => result.bytes <= maxBytes ? result : { bytes: result.bytes - file.size, count: index + 1 },
    { bytes: total, count: 0 },
  ).count;
  await Promise.all(retained.slice(0, overageCount).map(file => unlink(file.path)));
};

export const initializeLogFile = async (input: {
  readonly logDir: string;
  readonly runId: string;
  readonly pid?: number;
  readonly now?: Date;
}): Promise<OpenedDiagnosticLog> => {
  await mkdir(input.logDir, { recursive: true, mode: 0o700 });
  await chmod(input.logDir, 0o700);
  await pruneInteractiveLogs(input.logDir);
  const pid = input.pid ?? process.pid;
  const filename = `interactive-${fileTimestamp(input.now ?? new Date())}-${pid}-${safeFragment(input.runId)}.jsonl`;
  const path = join(input.logDir, filename);
  const handle = await open(path, "wx", 0o600);
  await chmod(path, 0o600);
  const latestPath = join(input.logDir, "interactive-latest.jsonl");
  const temporaryLink = join(input.logDir, `.interactive-latest-${pid}-${safeFragment(input.runId)}`);
  await symlink(basename(path), temporaryLink);
  await rename(temporaryLink, latestPath).catch(async error => {
    const existing = await lstat(latestPath).catch(() => undefined);
    if (existing !== undefined) await unlink(latestPath);
    await rename(temporaryLink, latestPath).catch(renameError => { throw renameError ?? error; });
  });
  return { handle, path, latestPath };
};
