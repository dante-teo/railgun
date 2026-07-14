import { z } from "zod";
import { parseCronSchedule } from "../shared/cron";
import {
  CronJobIdSchema,
  CronJobInputSchema,
  CronJobListSchema,
  CronJobSchema,
  DESKTOP_CRON_LIMITS,
} from "../shared/schemas";
import type { CronJob, CronJobInput } from "../shared/types";
import type { BackendRpcCommand } from "./backendSupervisor";
import type { MutationQueue } from "./mutationQueue";

type Call = <T>(command: BackendRpcCommand, validate: (data: unknown) => T) => Promise<T>;

const rawJob = z.strictObject({
  id: z.string().min(1).max(DESKTOP_CRON_LIMITS.id),
  schedule: z.string().min(1).max(DESKTOP_CRON_LIMITS.schedule),
  prompt: z.string().min(1).max(DESKTOP_CRON_LIMITS.prompt),
});
const rawListPage = z.strictObject({
  jobs: z.array(rawJob).max(1),
  nextCursor: z.number().int().nonnegative().optional(),
});
const rawMutation = z.strictObject({ jobId: CronJobIdSchema });

const parseEmptyResponse = (value: unknown): undefined => {
  if (value !== undefined) throw new Error("Backend RPC returned unexpected cron removal data");
  return undefined;
};

export const projectCronJob = (value: z.infer<typeof rawJob>): CronJob => {
  const parsed = parseCronSchedule(value.schedule);
  if (!parsed.valid) throw new Error(`Backend returned an invalid cron schedule: ${parsed.error}`);
  return CronJobSchema.parse({ id: value.id, schedule: parsed.schedule, summary: parsed.summary, prompt: value.prompt });
};

export const createCronService = (call: Call, mutations: MutationQueue) => ({
  list: async (): Promise<readonly CronJob[]> => {
    const jobs: CronJob[] = [];
    let cursor = 0;
    while (jobs.length < DESKTOP_CRON_LIMITS.jobs) {
      const result = await call(
        { type: "cron_list", cursor, limit: 1, editableOnly: true, maxPromptLength: DESKTOP_CRON_LIMITS.prompt },
        value => rawListPage.parse(value),
      );
      jobs.push(...result.jobs.map(projectCronJob));
      if (result.nextCursor === undefined) return CronJobListSchema.parse(jobs);
      if (result.nextCursor <= cursor) throw new Error("Backend returned an invalid cron cursor");
      cursor = result.nextCursor;
    }
    throw new Error(`Backend returned more than ${DESKTOP_CRON_LIMITS.jobs} cron jobs`);
  },
  create: (input: CronJobInput): Promise<CronJob> => mutations.run(async () => {
    const valid = CronJobInputSchema.parse(input);
    const result = await call({ type: "cron_add", ...valid, includeJob: false }, value => rawMutation.parse(value));
    return projectCronJob({ id: result.jobId, ...valid });
  }),
  update: (id: string, input: CronJobInput): Promise<CronJob> => mutations.run(async () => {
    const validId = CronJobIdSchema.parse(id);
    const valid = CronJobInputSchema.parse(input);
    const result = await call(
      { type: "cron_update", jobId: validId, patch: valid, includeJob: false },
      value => rawMutation.parse(value),
    );
    if (result.jobId !== validId) throw new Error("Backend returned a mismatched cron job");
    return projectCronJob({ id: validId, ...valid });
  }),
  delete: (id: string): Promise<void> => mutations.run(async () => {
    const validId = CronJobIdSchema.parse(id);
    await call({ type: "cron_remove", jobId: validId }, parseEmptyResponse);
  }),
});
