import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig } from "../config.js";
import { loadJobs } from "../cron/jobs.js";
import { reportDirectory } from "../cron/artifacts.js";
import { statusDaemon } from "../cron/daemon.js";
import type { DaemonStatus } from "../cron/daemon.js";
import type { RuntimeContext } from "../runtime.js";
import { createRuntimeContext } from "../runtime.js";
import { registry } from "./registry.js";
import type { ToolRunResult } from "./registry.js";

export type InspectionArea = "runtime" | "config" | "cron" | "logs" | "cron_runs";
export type LogSource = "interactive" | "cron" | "desktop";

export interface RailgunInspectArgs {
  readonly area: InspectionArea;
  readonly source?: LogSource;
  readonly job_id?: string;
  readonly limit?: number;
  readonly detail?: "summary" | "full";
  readonly report?: string;
}

export interface InspectorOptions {
  readonly runtime: RuntimeContext;
  readonly daemonStatus?: () => DaemonStatus;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 40;
const MAX_BYTES = 64 * 1024;
const MAX_STATE_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 128 * 1024;
const SECRET_KEY = /(?:token|password|passwd|secret|authorization|api[_-]?key|credential)/i;
const SECRET_FLAG = /^--?[^=\s]*(?:token|password|passwd|secret|authorization|api[_-]?key|credential)[^=\s]*$/i;
const SECRET_FLAG_VALUE = /^(--?[^=]*(?:token|password|passwd|secret|authorization|api[_-]?key|credential)[^=]*=).*$/i;
const SECRET_FLAG_INLINE_VALUE = /^(--?\S*(?:token|password|passwd|secret|authorization|api[_-]?key|credential)\S*\s+).*$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redactInlineCredentials = (value: string): string => value
  .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/((?:token|password|passwd|secret|authorization|api[_-]?key|credential)\s*[:=]\s*).*$/gi, "$1[REDACTED]")
  .replace(SECRET_FLAG_VALUE, "$1[REDACTED]")
  .replace(SECRET_FLAG_INLINE_VALUE, "$1[REDACTED]");

const redactArguments = (args: readonly unknown[]): unknown[] => {
  let redactNext = false;
  return args.map(arg => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (typeof arg !== "string") return redactConfig(arg, "args");
    if (SECRET_FLAG.test(arg)) {
      redactNext = true;
      return arg;
    }
    return redactInlineCredentials(arg);
  });
};

export const redactConfig = (value: unknown, parentKey = ""): unknown => {
  if (Array.isArray(value)) return parentKey === "args"
    ? redactArguments(value)
    : value.map(item => redactConfig(item, parentKey));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SECRET_KEY.test(key)) return [key, "[REDACTED]"];
    if (parentKey === "env") return [key, "[REDACTED]"];
    return [key, redactConfig(item, key)];
  }));
};

const boundedLimit = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT;

const boundedJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= MAX_OUTPUT_CHARS
    ? serialized
    : JSON.stringify({ truncated: true, preview: serialized.slice(0, MAX_OUTPUT_CHARS - 100) }, null, 2);
};

const requireBoundedStateFile = async (path: string): Promise<void> => {
  try {
    const info = await stat(path);
    if (info.size > MAX_STATE_FILE_BYTES) throw new Error(`Railgun state file exceeds the ${MAX_STATE_FILE_BYTES}-byte inspection limit: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const existsInventory = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const info = await stat(path);
    return { path, exists: true, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", ...(info.isFile() ? { bytes: info.size } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
    return { path, exists: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const readTail = async (path: string, lineLimit: number): Promise<Record<string, unknown>> => {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    const bytes = Math.min(info.size, MAX_BYTES);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    const decoded = buffer.toString("utf8");
    const complete = info.size <= bytes ? decoded : decoded.slice(Math.max(0, decoded.indexOf("\n") + 1));
    const availableLines = complete.split(/\r?\n/).filter(Boolean);
    const lines = availableLines.slice(-lineLimit);
    return { path, lines, truncated: info.size > bytes || availableLines.length > lineLimit };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, lines: [], missing: true };
    return { path, lines: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close();
  }
};

const readBoundedText = async (path: string): Promise<Record<string, unknown>> => {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (info.size <= MAX_BYTES) {
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      return { path, text: buffer.toString("utf8"), truncated: false };
    }
    const half = Math.floor(MAX_BYTES / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await Promise.all([
      handle.read(head, 0, half, 0),
      handle.read(tail, 0, half, info.size - half),
    ]);
    return {
      path,
      text: `${head.toString("utf8")}\n\n[... report truncated ...]\n\n${tail.toString("utf8")}`,
      truncated: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: "", missing: true };
    return { path, text: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close();
  }
};

const defaultLogSource = (runtime: RuntimeContext): LogSource =>
  runtime.surface === "cron" ? "cron" : runtime.surface === "desktop" ? "desktop" : "interactive";

const logPath = (runtime: RuntimeContext, source: LogSource): string => source === "cron"
  ? join(runtime.paths.cronLogs, "cron-latest.log")
  : join(runtime.paths.interactiveLogs, `${source}-latest.jsonl`);

const safeReportName = (name: string): boolean => basename(name) === name && name.endsWith(".md") && !name.includes("..") && name.length <= 200;

const listReports = async (directory: string, limit: number): Promise<string[]> => {
  try {
    return (await readdir(directory)).filter(safeReportName).sort().reverse().slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const summarizeReport = async (path: string): Promise<Record<string, unknown>> => {
  const excerpt = await readBoundedText(path);
  const lines = typeof excerpt.text === "string" ? excerpt.text.split(/\r?\n/).filter(Boolean) : [];
  const field = (label: string): string | undefined => lines.find(line => line.startsWith(`- ${label}: `))?.slice(label.length + 4);
  const failureHeading = lines.indexOf("## Failure reason");
  return {
    report: basename(path),
    status: field("Status") ?? "unknown",
    timestamp: field("Timestamp") ?? null,
    duration: field("Duration") ?? null,
    failureReason: failureHeading < 0 ? null : (lines[failureHeading + 1] ?? null)?.slice(0, 500) ?? null,
  };
};

export const inspectRailgun = async (args: RailgunInspectArgs, options: InspectorOptions): Promise<ToolRunResult> => {
  const { runtime } = options;
  const limit = boundedLimit(args.limit);
  try {
    if (args.area === "runtime") {
      const inventory = Object.fromEntries(await Promise.all(Object.entries(runtime.paths).map(async ([name, path]) => [name, await existsInventory(path)])));
      return { content: boundedJson({ surface: runtime.surface, cwd: process.cwd(), platform: process.platform, arch: process.arch, ...runtime.process, home: runtime.home, paths: inventory }), isError: false };
    }
    if (args.area === "config") {
      await requireBoundedStateFile(runtime.paths.config);
      const config = await loadConfig(runtime.paths.config);
      return { content: boundedJson({ path: runtime.paths.config, effective: redactConfig(config), restartRequiredAfterEdit: true }), isError: false };
    }
    if (args.area === "cron") {
      await requireBoundedStateFile(runtime.paths.cron);
      const jobs = await loadJobs(runtime.paths.cron);
      let daemon: DaemonStatus | { error: string };
      try { daemon = (options.daemonStatus ?? statusDaemon)(); }
      catch (error) { daemon = { error: error instanceof Error ? error.message : String(error) }; }
      return {
        content: boundedJson({ daemon: "detail" in daemon ? { ...daemon, detail: daemon.detail.slice(0, 16_000) } : daemon, jobs: jobs.slice(0, limit).map(job => ({
          id: job.id, schedule: job.schedule, lastRun: job.lastRun, lastSuccess: job.lastSuccess ?? null,
          lastStatus: job.lastStatus ?? null, lastError: job.lastError ?? null,
        })), truncated: jobs.length > limit }),
        isError: false,
      };
    }
    if (args.area === "logs") {
      const source = args.source ?? defaultLogSource(runtime);
      return { content: boundedJson({ source, ...(await readTail(logPath(runtime, source), limit)) }), isError: false };
    }
    if (args.area === "cron_runs") {
      if (typeof args.job_id !== "string" || args.job_id.trim() === "") {
        return { content: 'Error: cron_runs requires a non-empty "job_id".', isError: true };
      }
      const directory = reportDirectory(runtime.paths.cronOutput, args.job_id);
      const availableReports = await listReports(directory, MAX_LIMIT);
      const reports = availableReports.slice(0, limit);
      if (args.detail === "full") {
        const selected = args.report ?? reports[0];
        if (selected === undefined) return { content: JSON.stringify({ jobId: args.job_id, reports: [] }), isError: false };
        if (!safeReportName(selected) || !availableReports.includes(selected)) return { content: "Error: selected report is not an available Railgun cron report.", isError: true };
        return { content: boundedJson({ jobId: args.job_id, report: selected, ...(await readBoundedText(join(directory, selected))) }), isError: false };
      }
      return { content: boundedJson({ jobId: args.job_id, reports: await Promise.all(reports.map(name => summarizeReport(join(directory, name)))) }), isError: false };
    }
    return { content: `Error: unsupported inspection area ${String(args.area)}`, isError: true };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
};

registry.register({
  name: "railgun_inspect",
  toolset: "railgun",
  verb: "Inspecting Railgun",
  previewArgKey: "area",
  schema: {
    name: "railgun_inspect",
    description: "Read bounded Railgun runtime, redacted effective configuration, cron health, logs, or cron run reports. Use this before diagnosing Railgun operational problems.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        area: { type: "string", enum: ["runtime", "config", "cron", "logs", "cron_runs"] },
        source: { type: "string", enum: ["interactive", "cron", "desktop"] },
        job_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        detail: { type: "string", enum: ["summary", "full"] },
        report: { type: "string", description: "Exact report basename returned by a prior cron_runs summary." },
      },
      required: ["area"],
    },
  },
  handler: (args, context) => inspectRailgun(args as RailgunInspectArgs, { runtime: context.runtime ?? createRuntimeContext("interactive") }),
});
