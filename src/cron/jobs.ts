import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { CronExpressionParser } from "cron-parser";
import { CRON_PATH } from "../paths.js";

export interface CronJob {
  readonly id: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly lastRun: number | null;
  readonly requiredOutputs?: readonly string[];
  readonly lastSuccess?: number | null;
  readonly lastStatus?: "completed" | "incomplete" | "failed" | null;
  readonly lastError?: string | null;
}

export class CronJobsError extends Error {
  readonly name = "CronJobsError";

  constructor(readonly path: string, detail: string, options?: ErrorOptions) {
    super(`Invalid Railgun cron jobs at ${path}: ${detail}`, options);
  }
}

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export const validateJob = (value: unknown, path: string): CronJob => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CronJobsError(path, "each job must be an object");
  }

  const id = "id" in value ? value.id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new CronJobsError(path, "job `id` must be a non-empty string");
  }

  const schedule = "schedule" in value ? value.schedule : undefined;
  if (typeof schedule !== "string" || schedule.length === 0) {
    throw new CronJobsError(path, `job "${id}": \`schedule\` must be a non-empty string`);
  }
  try {
    CronExpressionParser.parse(schedule);
  } catch {
    throw new CronJobsError(path, `job "${id}": \`schedule\` "${schedule}" is not a valid cron expression`);
  }

  const prompt = "prompt" in value ? value.prompt : undefined;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new CronJobsError(path, `job "${id}": \`prompt\` must be a non-empty string`);
  }

  const lastRun = "lastRun" in value ? value.lastRun : undefined;
  if (lastRun !== null && typeof lastRun !== "number") {
    throw new CronJobsError(path, `job "${id}": \`lastRun\` must be a number or null`);
  }

  const requiredOutputs = "requiredOutputs" in value ? value.requiredOutputs : [];
  if (!Array.isArray(requiredOutputs) || requiredOutputs.length > 10 ||
      requiredOutputs.some(output => typeof output !== "string" || !isAbsolute(output)) ||
      new Set(requiredOutputs).size !== requiredOutputs.length) {
    throw new CronJobsError(path, `job "${id}": \`requiredOutputs\` must contain at most 10 unique absolute paths`);
  }

  const hasLastSuccess = "lastSuccess" in value;
  const lastSuccess = hasLastSuccess ? value.lastSuccess : (lastRun ?? null);
  if (lastSuccess !== null && typeof lastSuccess !== "number") {
    throw new CronJobsError(path, `job "${id}": \`lastSuccess\` must be a number or null`);
  }
  const lastStatus = "lastStatus" in value ? value.lastStatus : (lastRun == null ? null : "completed");
  if (lastStatus !== null && lastStatus !== "completed" && lastStatus !== "incomplete" && lastStatus !== "failed") {
    throw new CronJobsError(path, `job "${id}": \`lastStatus\` is invalid`);
  }
  const lastError = "lastError" in value ? value.lastError : null;
  if (lastError !== null && typeof lastError !== "string") {
    throw new CronJobsError(path, `job "${id}": \`lastError\` must be a string or null`);
  }

  return {
    id, schedule, prompt, lastRun: lastRun ?? null,
    requiredOutputs: requiredOutputs as string[],
    lastSuccess: lastSuccess as number | null,
    lastStatus: lastStatus as "completed" | "incomplete" | "failed" | null,
    lastError: lastError as string | null,
  };
};

interface LoadJobsOptions {
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

interface SaveJobsOptions {
  readonly atomicWrite?: (path: string, contents: string) => Promise<void>;
  readonly makeDirectory?: (path: string) => Promise<string | undefined>;
}

export const loadJobs = async (
  path = CRON_PATH,
  options: LoadJobsOptions = {},
): Promise<readonly CronJob[]> => {
  let contents: string;
  try {
    contents = await (options.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    const detail = error instanceof Error ? error.message : String(error);
    throw new CronJobsError(path, `could not read the file: ${detail}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new CronJobsError(path, "the file contains malformed JSON", { cause: error });
  }

  if (!Array.isArray(value)) {
    throw new CronJobsError(path, "jobs file must contain a JSON array");
  }

  return value.map((item: unknown) => validateJob(item, path));
};

const defaultAtomicWrite = (path: string, contents: string): Promise<void> =>
  writeFileAtomic(path, contents, { encoding: "utf8", mode: 0o600 });

const defaultMakeDirectory = (path: string): Promise<string | undefined> =>
  mkdir(path, { recursive: true, mode: 0o700 });

export const saveJobs = async (
  jobs: readonly CronJob[],
  path = CRON_PATH,
  options: SaveJobsOptions = {},
): Promise<void> => {
  await (options.makeDirectory ?? defaultMakeDirectory)(dirname(path));
  await (options.atomicWrite ?? defaultAtomicWrite)(path, `${JSON.stringify(jobs, null, 2)}\n`);
};

export const isDue = (job: CronJob, now: number): boolean => {
  if (job.lastRun === null) return true;
  const expr = CronExpressionParser.parse(job.schedule, { currentDate: new Date(now) });
  return expr.prev().getTime() > job.lastRun;
};
