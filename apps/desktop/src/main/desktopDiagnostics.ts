import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TransportLogEntry } from "../shared/types";

export interface DesktopDiagnosticRecord {
  readonly timestamp: string;
  readonly category: "transport" | "lifecycle";
  readonly direction?: TransportLogEntry["direction"];
  readonly text: string;
}

export interface DesktopDiagnosticSink {
  readonly path: string;
  readonly write: (record: Omit<DesktopDiagnosticRecord, "timestamp">) => void;
}

interface DesktopDiagnosticOptions {
  readonly home: string;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly maxAgeMs?: number;
  readonly maxAggregateBytes?: number;
}

const desktopLogPattern = /^desktop-\d{4}-\d{2}-\d{2}T[\d-]+\.\d{3}Z-\d+\.jsonl$/;

const prune = (
  directory: string,
  activePath: string,
  now: number,
  maxAgeMs: number,
  maxAggregateBytes: number,
  reserveBytes = 0,
): number => {
  const files = readdirSync(directory).filter(name => desktopLogPattern.test(name)).map(name => {
    const path = join(directory, name);
    const info = statSync(path);
    return { path, mtimeMs: info.mtimeMs, size: info.size };
  }).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (file.path === activePath) continue;
    if (now - file.mtimeMs <= maxAgeMs && total + reserveBytes <= maxAggregateBytes) continue;
    try { unlinkSync(file.path); total -= file.size; } catch { /* diagnostics must never crash the app */ }
  }
  return total;
};

const createPersistentDesktopDiagnosticSink = (options: DesktopDiagnosticOptions): DesktopDiagnosticSink => {
  const now = options.now ?? (() => new Date());
  const directory = join(options.home, ".railgun", "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const started = now();
  const filename = `desktop-${started.toISOString().replaceAll(":", "-")}-${options.pid ?? process.pid}.jsonl`;
  const path = join(directory, filename);
  appendFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);

  const latest = join(directory, "desktop-latest.jsonl");
  const temporary = join(directory, `.desktop-latest-${options.pid ?? process.pid}-${Date.now()}`);
  try {
    symlinkSync(filename, temporary);
    renameSync(temporary, latest);
  } catch {
    try { unlinkSync(temporary); } catch { /* ignore */ }
    try { unlinkSync(latest); } catch { /* absent is fine */ }
    try { symlinkSync(filename, latest); } catch { /* persistence remains available through the launch file */ }
  }
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxAggregateBytes = options.maxAggregateBytes ?? 100 * 1024 * 1024;
  prune(directory, path, started.getTime(), maxAgeMs, maxAggregateBytes);

  return {
    path,
    write: record => {
      try {
        const observedAt = now();
        const line = `${JSON.stringify({ timestamp: observedAt.toISOString(), ...record })}\n`;
        const lineBytes = Buffer.byteLength(line);
        const aggregateBytes = prune(directory, path, observedAt.getTime(), maxAgeMs, maxAggregateBytes, lineBytes);
        if (aggregateBytes + lineBytes > maxAggregateBytes) return;
        appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      }
      catch { /* diagnostics must never affect backend supervision */ }
    },
  };
};

const noopSink = (): DesktopDiagnosticSink => ({ path: "", write: () => undefined });

export const createDesktopDiagnosticSink = (options: DesktopDiagnosticOptions): DesktopDiagnosticSink => {
  try {
    return createPersistentDesktopDiagnosticSink(options);
  } catch {
    return noopSink();
  }
};
