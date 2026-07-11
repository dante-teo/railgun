import type { DevinProvider, DevinModel } from "widevin";
import type { AppConfig } from "../config.js";
import { createAgentSession } from "../agent/agentSession.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { createTodoStore } from "../tools/todo.js";
import { loadJobs, saveJobs, isDue } from "./jobs.js";
import type { CronJob } from "./jobs.js";

export interface CronJobResult {
  readonly jobId: string;
  readonly ok: boolean;
  readonly text: string;
  readonly error?: unknown;
}

export const runCronJob = async (
  job: CronJob,
  devin: DevinProvider,
  model: DevinModel,
  systemPrompt: readonly string[],
  config: AppConfig,
  log: (msg: string) => void,
): Promise<CronJobResult> => {
  log(`Running cron job: ${job.id}`);

  const approvalMode = config.approvalMode ?? "manual";
  const confirmShellCommand = async (): Promise<boolean> => approvalMode === "off";

  const agentSession = createAgentSession({
    devin,
    model: model.id,
    contextWindow: model.contextWindow,
    systemPrompt,
    confirmShellCommand,
    todoStore: createTodoStore(),
    commandApprovalMode: approvalMode,
    iterationBudget: () => IterationBudget.create(30),
  });

  let text = "";

  agentSession.subscribe(event => {
    if (event.type === "message_update" && event.streamEvent.type === "text_delta") {
      text += event.streamEvent.delta;
    } else if (event.type === "tool_execution_start") {
      log(`[cron:${job.id}] tool start: ${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      log(`[cron:${job.id}] tool end: ${event.toolName} (${event.result.isError ? "error" : "ok"})`);
    }
  });

  try {
    const outcome = await agentSession.run({ history: [], text: job.prompt });
    if (outcome.ok) {
      return { jobId: job.id, ok: true, text };
    }
    if ("aborted" in outcome) {
      return { jobId: job.id, ok: false, text, error: new Error("aborted") };
    }
    return { jobId: job.id, ok: false, text, error: outcome.error };
  } catch (error) {
    return { jobId: job.id, ok: false, text, error };
  }
};

export const tick = async (
  jobs: readonly CronJob[],
  now: number,
  runJob: (job: CronJob) => Promise<CronJobResult>,
): Promise<readonly CronJob[]> => {
  const updated = [...jobs];
  for (const [i, job] of updated.entries()) {
    if (!isDue(job, now)) continue;
    await runJob(job);
    updated[i] = { ...job, lastRun: now };
  }
  return updated;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  return promise;
};

export const startScheduler = async (
  devin: DevinProvider,
  model: DevinModel,
  systemPrompt: readonly string[],
  config: AppConfig,
  options: { interval?: number; signal?: AbortSignal; log?: (msg: string) => void } = {},
): Promise<void> => {
  const interval = options.interval ?? 60_000;
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const runJob = (job: CronJob): Promise<CronJobResult> =>
    runCronJob(job, devin, model, systemPrompt, config, log);

  log(`Cron scheduler started. Checking every ${interval / 1000}s...`);

  while (!signal.aborted) {
    const jobs = await loadJobs();
    const now = Date.now();
    const updated = await tick(jobs, now, runJob);
    const anyRan = updated.some((job, i) => job.lastRun !== jobs[i]?.lastRun);
    if (anyRan) await saveJobs(updated);
    if (!signal.aborted) await sleep(interval, signal);
  }

  log("Cron scheduler stopped.");
};
