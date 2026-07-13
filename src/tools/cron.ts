import { registry } from "./registry.js";
import { loadJobs, saveJobs, validateJob, CronJobsError } from "../cron/jobs.js";
import { CRON_PATH } from "../paths.js";
import { extractString } from "./args.js";

registry.register({
  name: "cron",
  toolset: "cron",
  verb: "Managing cron",
  previewArgKey: "action",
  schema: {
    name: "cron",
    description:
      "Manage scheduled agent tasks (cron jobs). Each job runs a prompt on a cron schedule. " +
      "Use 'list' to see all jobs, 'add' to create one, 'remove' to delete one by id, " +
      "'update' to change a job's schedule or prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove", "update"],
          description: "The operation to perform on cron jobs.",
        },
        id: {
          type: "string",
          description: "Job identifier. Required for add, remove, and update.",
        },
        schedule: {
          type: "string",
          description: "Cron expression (e.g. '0 9 * * *'). Required for add; optional for update.",
        },
        prompt: {
          type: "string",
          description: "The agent prompt to run on schedule. Required for add; optional for update.",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args) => {
    const action = extractString(args, "action");
    if (!action) {
      return { content: 'Error: cron requires a non-empty "action" argument', isError: true };
    }

    try {
      if (action === "list") {
        const jobs = await loadJobs();
        if (jobs.length === 0) return { content: "No cron jobs configured.", isError: false };
        return { content: JSON.stringify(jobs, null, 2), isError: false };
      }

      if (action === "add") {
        const id = extractString(args, "id");
        const schedule = extractString(args, "schedule");
        const prompt = extractString(args, "prompt");
        if (!id || !schedule || !prompt) {
          return { content: 'Error: add requires non-empty "id", "schedule", and "prompt"', isError: true };
        }
        const jobs = await loadJobs();
        if (jobs.some(j => j.id === id)) {
          return { content: `Error: a cron job with id "${id}" already exists`, isError: true };
        }
        const newJob = validateJob({ id, schedule, prompt, lastRun: null }, CRON_PATH);
        await saveJobs([...jobs, newJob]);
        return { content: `Added cron job "${id}": ${schedule} → ${prompt}`, isError: false };
      }

      if (action === "remove") {
        const id = extractString(args, "id");
        if (!id) {
          return { content: 'Error: remove requires a non-empty "id"', isError: true };
        }
        const jobs = await loadJobs();
        if (!jobs.some(j => j.id === id)) {
          return { content: `Error: no cron job found with id "${id}"`, isError: true };
        }
        await saveJobs(jobs.filter(j => j.id !== id));
        return { content: `Removed cron job "${id}".`, isError: false };
      }

      if (action === "update") {
        const id = extractString(args, "id");
        if (!id) {
          return { content: 'Error: update requires a non-empty "id"', isError: true };
        }
        const schedule = extractString(args, "schedule");
        const prompt = extractString(args, "prompt");
        if (!schedule && !prompt) {
          return { content: 'Error: update requires at least one of "schedule" or "prompt"', isError: true };
        }
        const jobs = await loadJobs();
        const existing = jobs.find(j => j.id === id);
        if (!existing) {
          return { content: `Error: no cron job found with id "${id}"`, isError: true };
        }
        const updated = validateJob(
          { ...existing, ...(schedule ? { schedule } : {}), ...(prompt ? { prompt } : {}) },
          CRON_PATH,
        );
        await saveJobs(jobs.map(j => (j.id === id ? updated : j)));
        return { content: `Updated cron job "${id}": ${updated.schedule} → ${updated.prompt}`, isError: false };
      }

      return { content: `Error: unknown action "${action}"`, isError: true };
    } catch (error) {
      if (error instanceof CronJobsError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  },
});
