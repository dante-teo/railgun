import { appendFileSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DevinProvider, DevinModel } from "widevin";
import type { AppConfig } from "../config.js";
import { CRON_LOGS_PATH, CRON_OUTPUT_PATH } from "../paths.js";
import { createAgentSession } from "../agent/agentSession.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { createTodoStore } from "../tools/todo.js";
import { resolveSystemPrompt } from "../skills.js";
import { loadJobs, saveJobs, isDue } from "./jobs.js";
import type { CronJob } from "./jobs.js";
import { snapshotOutputs, verifyOutputs, writeRunReport } from "./artifacts.js";
import type { OutputVerification } from "./artifacts.js";
import { createRuntimeContext } from "../runtime.js";

export interface CronJobResult {
  readonly jobId: string;
  readonly ok: boolean;
  readonly text: string;
  readonly error?: unknown;
  readonly status?: "completed" | "incomplete" | "failed";
}


// ─── helpers ──────────────────────────────────────────────────────────────────

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// ─── log-path helpers ─────────────────────────────────────────────────────────
// All date arithmetic uses UTC calendar days (ISO 8601 date strings) for
// simplicity and testability. Log files roll over at UTC midnight, which may
// differ from local midnight for users outside UTC.

export const cronLogPath = (date: Date): string =>
  join(CRON_LOGS_PATH, `cron-${date.toISOString().slice(0, 10)}.log`);

export const cleanOldLogs = (
  logsDir: string,
  maxAgeDays: number,
  onError?: (msg: string) => void,
): void => {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch (err) {
    // ENOENT is expected on first run — directory not yet created.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onError?.(`Failed to read log directory: ${errMsg(err)}`);
    }
    return;
  }
  // Both sides use UTC midnight so the comparison is timezone-independent.
  const todayMidnight = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const cutoff = todayMidnight - maxAgeDays * 24 * 60 * 60 * 1000;
  const pattern = /^cron-(\d{4}-\d{2}-\d{2})\.log$/;
  for (const name of entries) {
    const m = pattern.exec(name);
    if (!m) continue;
    if (new Date(m[1]!).getTime() < cutoff) {
      try {
        unlinkSync(join(logsDir, name));
      } catch (err) {
        onError?.(`Failed to delete old log ${name}: ${errMsg(err)}`);
      }
    }
  }
};

// ─── logger factory ───────────────────────────────────────────────────────────

export const createCronLogger = (): (msg: string) => void => {
  let currentDate = "";
  let dirEnsured = false;

  const ensureDir = (): void => {
    if (!dirEnsured) {
      mkdirSync(CRON_LOGS_PATH, { recursive: true });
      dirEnsured = true;
    }
  };

  const updateSymlink = (logPath: string): void => {
    const symlinkPath = join(CRON_LOGS_PATH, "cron-latest.log");
    try { unlinkSync(symlinkPath); } catch { /* ignore if absent */ }
    try { symlinkSync(logPath, symlinkPath); } catch { /* ignore permission errors */ }
  };

  return (msg: string): void => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    ensureDir();
    if (today !== currentDate) {
      currentDate = today;
      updateSymlink(cronLogPath(now));
    }
    const logPath = cronLogPath(now);
    try { appendFileSync(logPath, `[${now.toISOString()}] ${msg}\n`); } catch { /* ignore write errors */ }
  };
};

// ─── runCronJob ───────────────────────────────────────────────────────────────

export const runCronJob = async (
  job: CronJob,
  devin: DevinProvider,
  model: DevinModel,
  systemPrompt: readonly string[],
  config: AppConfig,
  log: (msg: string) => void,
  options: { readonly reportRoot?: string; readonly now?: () => Date } = {},
): Promise<CronJobResult> => {
  const startTime = Date.now();
  const timestamp = (options.now ?? (() => new Date()))();
  const pfx = `[cron:${job.id}]`;
  log(`Running cron job: ${job.id}`);

  const approvalMode = config.approvalMode ?? "manual";
  const confirmShellCommand = async (): Promise<boolean> => approvalMode === "off";

  const agentSession = createAgentSession({
    devin,
    model: model.id,
    contextWindow: model.contextWindow,
    systemPrompt: resolveSystemPrompt(systemPrompt),
    confirmShellCommand,
    todoStore: createTodoStore(),
    commandApprovalMode: approvalMode,
    ...(config.operationTimeoutMs !== undefined ? { operationTimeoutMs: config.operationTimeoutMs } : {}),
    iterationBudget: () => IterationBudget.create(30),
    cron: true,
    runtime: createRuntimeContext("cron"),
  });

  let text = "";
  let turnCount = 0;
  let toolCallCount = 0;

  agentSession.subscribe(event => {
    if (event.type === "message_update" && event.streamEvent.type === "text_delta") {
      text += event.streamEvent.delta;
    } else if (event.type === "turn_start") {
      turnCount += 1;
      log(`${pfx} turn ${turnCount} started`);
    } else if (event.type === "turn_end") {
      log(`${pfx} turn ${turnCount} ended (${event.toolResults.length} tool calls)`);
    } else if (event.type === "agent_end") {
      log(`${pfx} agent finished (${event.messages.length} messages)`);
    } else if (event.type === "compaction_start") {
      log(`${pfx} context compaction (${event.reason})`);
    } else if (event.type === "compaction_end") {
      log(`${pfx} context compaction done`);
    } else if (event.type === "subagent_start") {
      const preview = event.goal.length > 80 ? `${event.goal.slice(0, 80)}…` : event.goal;
      log(`${pfx} subagent ${event.index + 1}/${event.count}: "${preview}"`);
    } else if (event.type === "subagent_end") {
      log(`${pfx} subagent ${event.index + 1} done`);
    } else if (event.type === "tool_execution_start") {
      const argStr = JSON.stringify(event.args);
      const preview = argStr.length > 80 ? `${argStr.slice(0, 80)}…` : argStr;
      log(`${pfx} tool start: ${event.toolName} ${preview}`);
    } else if (event.type === "tool_execution_end") {
      toolCallCount += 1;
      if (event.result.isError) {
        log(`${pfx} tool end: ${event.toolName} (error: "${event.result.content.slice(0, 200)}")`);
      } else {
        log(`${pfx} tool end: ${event.toolName} (ok)`);
      }
    }
  });

  const durationSec = (): string => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  const requiredOutputs = job.requiredOutputs ?? [];
  const runPrompt = requiredOutputs.length === 0
    ? job.prompt
    : `${job.prompt}\n\nRequired output contract: write and verify each of these absolute paths during this run:\n${requiredOutputs.map(path => `- ${path}`).join("\n")}`;
  let verification: readonly OutputVerification[] = [];
  let status: "completed" | "incomplete" | "failed" = "failed";
  let finalText = "";
  let failureReason: string | null = null;
  let resultError: unknown;

  try {
    const before = await snapshotOutputs(requiredOutputs);
    const outcome = await agentSession.run({ history: [], text: runPrompt });
    verification = await verifyOutputs(requiredOutputs, before);
    if (outcome.ok) {
      finalText = outcome.assistantText.trim();
      const outputFailure = verification.find(item => !item.satisfied);
      failureReason = outcome.stopReason === "iteration_limit"
        ? "iteration limit reached"
        : finalText === ""
          ? "empty final response"
          : outputFailure
            ? `required output ${outputFailure.path}: ${outputFailure.reason}`
            : null;
      status = failureReason === null ? "completed" : "incomplete";
      if (failureReason !== null) resultError = new Error(failureReason);
    } else if ("aborted" in outcome) {
      finalText = outcome.assistantText.trim();
      failureReason = "aborted";
      resultError = new Error("aborted");
      status = "failed";
    } else {
      failureReason = errMsg(outcome.error);
      resultError = outcome.error;
      status = "failed";
    }
  } catch (error) {
    failureReason = errMsg(error);
    resultError = error;
    status = "failed";
  }

  try {
    await writeRunReport(options.reportRoot ?? CRON_OUTPUT_PATH, {
      jobId: job.id, schedule: job.schedule, prompt: job.prompt, status,
      durationMs: Date.now() - startTime, turnCount, toolCallCount, verification,
      finalResponse: finalText || (status === "failed" ? text.trim() : ""), failureReason, timestamp,
    });
  } catch (error) {
    status = "failed";
    failureReason = `failed to write run report: ${errMsg(error)}`;
    resultError = error;
    log(`${pfx} ${failureReason}`);
  }

  const summary = status === "completed" ? "completed in" : status === "incomplete" ? "incomplete after" : "failed after";
  log(`${pfx} ${summary} ${durationSec()} (${turnCount} turns, ${toolCallCount} tool calls)${failureReason ? `: ${failureReason}` : ""}`);
  return {
    jobId: job.id, ok: status === "completed", status, text: finalText || text.trim(),
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
};

// ─── tick ─────────────────────────────────────────────────────────────────────

export const tick = async (
  jobs: readonly CronJob[],
  now: number,
  runJob: (job: CronJob) => Promise<CronJobResult>,
): Promise<readonly CronJob[]> => jobs.reduce<Promise<readonly CronJob[]>>(async (updatedJobs, job) => {
  const updated = await updatedJobs;
  if (!isDue(job, now)) return [...updated, job];
  const result = await runJob(job);
  const status = result.status ?? (result.ok ? "completed" : "failed");
  return [...updated, {
    ...job,
    lastRun: now,
    lastStatus: status,
    lastError: status === "completed" ? null : errMsg(result.error ?? `${status} cron run`),
    ...(status === "completed" ? { lastSuccess: now } : {}),
  }];
}, Promise.resolve([]));

// ─── sleep ────────────────────────────────────────────────────────────────────

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  return promise;
};

// ─── startScheduler ───────────────────────────────────────────────────────────

export const startScheduler = async (
  devin: DevinProvider,
  model: DevinModel,
  systemPrompt: readonly string[],
  config: AppConfig,
  options: { interval?: number; signal?: AbortSignal; log?: (msg: string) => void; reportRoot?: string } = {},
): Promise<void> => {
  const interval = options.interval ?? 60_000;
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? createCronLogger();
  const runId = `run-${process.pid}-${Date.now()}`;
  const runJob = (job: CronJob): Promise<CronJobResult> =>
    runCronJob(job, devin, model, systemPrompt, config, log, { ...(options.reportRoot ? { reportRoot: options.reportRoot } : {}) });

  log(`Cron scheduler started [${runId}]. Checking every ${interval / 1000}s...`);
  log(`Cron logs directory: ~/.railgun/cron/logs/`);

  cleanOldLogs(CRON_LOGS_PATH, 7, msg => log(`Log rotation: ${msg}`));

  let idleCount = 0;
  let lastJobCount = -1; // -1 = never logged yet

  while (!signal.aborted) {
    let jobs: readonly CronJob[];
    try {
      jobs = await loadJobs();
    } catch (error) {
      log(`Failed to load jobs: ${errMsg(error)}`);
      if (!signal.aborted) await sleep(interval, signal);
      continue;
    }

    if (jobs.length !== lastJobCount) {
      lastJobCount = jobs.length;
      if (jobs.length === 0) {
        log("No cron jobs configured");
      } else {
        log(`Loaded ${jobs.length} cron job${jobs.length === 1 ? "" : "s"}`);
      }
    }
    const now = Date.now();
    const anyDue = jobs.some(j => isDue(j, now));
    const updated = await tick(jobs, now, runJob);
    const anyAttempted = updated.some((job, i) => job.lastRun !== jobs[i]?.lastRun);

    if (!anyDue) {
      idleCount += 1;
      if (idleCount % 5 === 1) {
        log(`No jobs due, sleeping ${interval / 1000}s`);
      }
    } else {
      idleCount = 0;
      if (anyAttempted) {
        try {
          await saveJobs(updated);
        } catch (error) {
          log(`Failed to save jobs: ${errMsg(error)}`);
        }
      }
    }

    if (!signal.aborted) await sleep(interval, signal);
  }

  log(`Cron scheduler stopped [${runId}].`);
};
