import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/jobs.js";

vi.mock("../cron/jobs.js", () => {
  const CronJobsError = class CronJobsError extends Error {
    readonly name = "CronJobsError";
    constructor(readonly path: string, detail: string, options?: ErrorOptions) {
      super(`Invalid Railgun cron jobs at ${path}: ${detail}`, options);
    }
  };

  const validateJob = (value: unknown, path: string): CronJob => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CronJobsError(path, "each job must be an object");
    }
    const v = value as Record<string, unknown>;

    const id = v.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new CronJobsError(path, "job `id` must be a non-empty string");
    }
    const schedule = v.schedule;
    if (typeof schedule !== "string" || schedule.length === 0) {
      throw new CronJobsError(path, `job "${id}": \`schedule\` must be a non-empty string`);
    }
    // Simulate invalid cron expression check
    if (schedule === "INVALID") {
      throw new CronJobsError(path, `job "${id}": \`schedule\` "INVALID" is not a valid cron expression`);
    }
    const prompt = v.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new CronJobsError(path, `job "${id}": \`prompt\` must be a non-empty string`);
    }
    const lastRun = v.lastRun;
    if (lastRun !== null && lastRun !== undefined && typeof lastRun !== "number") {
      throw new CronJobsError(path, `job "${id}": \`lastRun\` must be a number or null`);
    }
    const requiredOutputs = v.requiredOutputs ?? [];
    if (!Array.isArray(requiredOutputs) || requiredOutputs.some(item => typeof item !== "string" || !item.startsWith("/"))) {
      throw new CronJobsError(path, `job "${id}": invalid required outputs`);
    }
    return { id, schedule, prompt, lastRun: (lastRun as number | null) ?? null, requiredOutputs: requiredOutputs as string[] };
  };

  return { CronJobsError, validateJob, loadJobs: vi.fn(), saveJobs: vi.fn() };
});

import { registry } from "./index.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";

const mockLoadJobs = vi.mocked(loadJobs);
const mockSaveJobs = vi.mocked(saveJobs);

const makeContext = () => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual" as const,
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => {
    throw new Error("confirmShellCommand should not be called");
  },
});

const run = (args: unknown) => registry.run("cron", args, makeContext());

describe("cron tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveJobs.mockResolvedValue(undefined);
  });

  // ─── list ────────────────────────────────────────────────────────────────

  it("list returns formatted JSON when jobs exist", async () => {
    const jobs: CronJob[] = [
      { id: "daily", schedule: "0 9 * * *", prompt: "Summarize git log", lastRun: null },
    ];
    mockLoadJobs.mockResolvedValue(jobs);

    const result = await run({ action: "list" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("daily");
    expect(result.content).toContain("0 9 * * *");
  });

  it("list returns no-jobs message when empty", async () => {
    mockLoadJobs.mockResolvedValue([]);

    const result = await run({ action: "list" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No cron jobs configured.");
  });

  // ─── add ─────────────────────────────────────────────────────────────────

  it("add with valid args saves and returns confirmation", async () => {
    mockLoadJobs.mockResolvedValue([]);

    const result = await run({ action: "add", id: "daily", schedule: "0 9 * * *", prompt: "Summarize" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('"daily"');
    expect(mockSaveJobs).toHaveBeenCalledOnce();
    const saved = mockSaveJobs.mock.calls[0]![0] as CronJob[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "daily", schedule: "0 9 * * *", prompt: "Summarize", lastRun: null });
  });

  it("add accepts and validates required_outputs", async () => {
    mockLoadJobs.mockResolvedValue([]);
    const result = await run({ action: "add", id: "daily", schedule: "0 9 * * *", prompt: "Summarize", required_outputs: ["/tmp/report.md"] });
    expect(result.isError).toBe(false);
    expect((mockSaveJobs.mock.calls[0]![0] as CronJob[])[0]?.requiredOutputs).toEqual(["/tmp/report.md"]);
    expect((await run({ action: "add", id: "bad", schedule: "0 9 * * *", prompt: "x", required_outputs: ["relative.md"] })).isError).toBe(true);
  });

  it("add with duplicate id returns isError: true", async () => {
    mockLoadJobs.mockResolvedValue([
      { id: "daily", schedule: "0 9 * * *", prompt: "existing", lastRun: null },
    ]);

    const result = await run({ action: "add", id: "daily", schedule: "0 0 * * *", prompt: "new" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"daily"');
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  it("add with missing id returns isError: true", async () => {
    const result = await run({ action: "add", schedule: "0 9 * * *", prompt: "Summarize" });
    expect(result.isError).toBe(true);
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  it("add with missing schedule returns isError: true", async () => {
    const result = await run({ action: "add", id: "daily", prompt: "Summarize" });
    expect(result.isError).toBe(true);
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  it("add with missing prompt returns isError: true", async () => {
    const result = await run({ action: "add", id: "daily", schedule: "0 9 * * *" });
    expect(result.isError).toBe(true);
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  it("add with invalid cron expression returns isError: true", async () => {
    mockLoadJobs.mockResolvedValue([]);

    const result = await run({ action: "add", id: "bad", schedule: "INVALID", prompt: "Something" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("INVALID");
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it("remove with valid id removes and returns confirmation", async () => {
    mockLoadJobs.mockResolvedValue([
      { id: "daily", schedule: "0 9 * * *", prompt: "Summarize", lastRun: null },
    ]);

    const result = await run({ action: "remove", id: "daily" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('"daily"');
    expect(mockSaveJobs).toHaveBeenCalledOnce();
    const saved = mockSaveJobs.mock.calls[0]![0] as CronJob[];
    expect(saved).toHaveLength(0);
  });

  it("remove with unknown id returns isError: true", async () => {
    mockLoadJobs.mockResolvedValue([]);

    const result = await run({ action: "remove", id: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"nope"');
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  // ─── update ──────────────────────────────────────────────────────────────

  it("update with valid schedule changes the schedule", async () => {
    mockLoadJobs.mockResolvedValue([
      { id: "daily", schedule: "0 9 * * *", prompt: "Old prompt", lastRun: null },
    ]);

    const result = await run({ action: "update", id: "daily", schedule: "0 8 * * *" });

    expect(result.isError).toBe(false);
    expect(mockSaveJobs).toHaveBeenCalledOnce();
    const saved = mockSaveJobs.mock.calls[0]![0] as CronJob[];
    expect(saved[0]).toMatchObject({ id: "daily", schedule: "0 8 * * *", prompt: "Old prompt" });
  });

  it("update with valid prompt changes the prompt", async () => {
    mockLoadJobs.mockResolvedValue([
      { id: "daily", schedule: "0 9 * * *", prompt: "Old prompt", lastRun: null },
    ]);

    const result = await run({ action: "update", id: "daily", prompt: "New prompt" });

    expect(result.isError).toBe(false);
    expect(mockSaveJobs).toHaveBeenCalledOnce();
    const saved = mockSaveJobs.mock.calls[0]![0] as CronJob[];
    expect(saved[0]).toMatchObject({ id: "daily", schedule: "0 9 * * *", prompt: "New prompt" });
  });

  it("update can clear required_outputs", async () => {
    mockLoadJobs.mockResolvedValue([
      { id: "daily", schedule: "0 9 * * *", prompt: "Old prompt", lastRun: null, requiredOutputs: ["/tmp/old.md"] },
    ]);
    const result = await run({ action: "update", id: "daily", required_outputs: [] });
    expect(result.isError).toBe(false);
    expect((mockSaveJobs.mock.calls[0]![0] as CronJob[])[0]?.requiredOutputs).toEqual([]);
  });

  it("update with unknown id returns isError: true", async () => {
    mockLoadJobs.mockResolvedValue([]);

    const result = await run({ action: "update", id: "ghost", prompt: "Something" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"ghost"');
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  it("update with neither schedule nor prompt returns isError: true", async () => {
    const result = await run({ action: "update", id: "daily" });
    expect(result.isError).toBe(true);
    expect(mockSaveJobs).not.toHaveBeenCalled();
  });

  // ─── toolset registration ─────────────────────────────────────────────────

  it("exposes the cron schema in the cron toolset", () => {
    const schemas = registry.getSchemas(["cron"]);
    expect(schemas.some(s => s.name === "cron")).toBe(true);
  });
});
