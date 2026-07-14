import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronJobsError, isDue, loadJobs, saveJobs, validateJob } from "./jobs.js";
import type { CronJob } from "./jobs.js";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "railgun-cron-jobs-"));
  path = join(directory, "cron", "jobs.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const validJob: CronJob = {
  id: "test-job",
  schedule: "0 9 * * *",
  prompt: "What is 2 + 2?",
  lastRun: null,
};

describe("loadJobs", () => {
  it("normalizes legacy successful jobs", async () => {
    const jobs = await loadJobs("/cron.json", {
      readFile: async () => JSON.stringify([{ id: "legacy", schedule: "0 9 * * *", prompt: "go", lastRun: 123 }]),
    });
    expect(jobs[0]).toMatchObject({
      requiredOutputs: [], lastRun: 123, lastSuccess: 123, lastStatus: "completed", lastError: null,
    });
  });

  it("returns [] when the file does not exist", async () => {
    await expect(loadJobs(path)).resolves.toEqual([]);
  });

  it("parses a valid jobs array", async () => {
    await writeFile(join(directory, "jobs.json"), JSON.stringify([validJob]), { encoding: "utf8" });
    const jobs = await loadJobs(join(directory, "jobs.json"));
    expect(jobs[0]).toMatchObject(validJob);
    expect(jobs[0]?.requiredOutputs).toEqual([]);
  });

  it("returns multiple jobs", async () => {
    const second: CronJob = { id: "job-2", schedule: "*/5 * * * *", prompt: "Hello", lastRun: 1000 };
    await writeFile(join(directory, "jobs.json"), JSON.stringify([validJob, second]), { encoding: "utf8" });
    const jobs = await loadJobs(join(directory, "jobs.json"));
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject(second);
    expect(jobs[1]?.lastSuccess).toBe(1000);
  });

  it("throws CronJobsError on malformed JSON", async () => {
    const mockRead = vi.fn(async () => "{not valid json");
    await expect(loadJobs(path, { readFile: mockRead }))
      .rejects.toThrow(CronJobsError);
  });

  it("throws CronJobsError when root is not an array", async () => {
    const mockRead = vi.fn(async () => JSON.stringify({ id: "x" }));
    await expect(loadJobs(path, { readFile: mockRead }))
      .rejects.toThrow(CronJobsError);
  });

  it("throws CronJobsError when a job is missing id", async () => {
    const mockRead = vi.fn(async () => JSON.stringify([{ schedule: "* * * * *", prompt: "hi", lastRun: null }]));
    await expect(loadJobs(path, { readFile: mockRead }))
      .rejects.toThrow(CronJobsError);
  });

  it("throws CronJobsError when schedule is an invalid cron expression", async () => {
    const mockRead = vi.fn(async () => JSON.stringify([{ id: "x", schedule: "not-a-cron", prompt: "hi", lastRun: null }]));
    await expect(loadJobs(path, { readFile: mockRead }))
      .rejects.toThrow(CronJobsError);
  });

  it("throws CronJobsError when prompt is empty", async () => {
    const mockRead = vi.fn(async () => JSON.stringify([{ id: "x", schedule: "* * * * *", prompt: "", lastRun: null }]));
    await expect(loadJobs(path, { readFile: mockRead }))
      .rejects.toThrow(CronJobsError);
  });

  it("throws CronJobsError on non-ENOENT read errors and includes the path", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const mockRead = vi.fn(async () => { throw failure; });
    await expect(loadJobs("/blocked/cron.json", { readFile: mockRead }))
      .rejects.toMatchObject({ name: "CronJobsError", path: "/blocked/cron.json" });
  });
});

describe("saveJobs", () => {
  it("writes pretty JSON with a trailing newline", async () => {
    const atomicWrite = vi.fn(async (_path: string, _contents: string) => {});
    const makeDirectory = vi.fn(async () => undefined);

    await saveJobs([validJob], path, { atomicWrite, makeDirectory });

    expect(atomicWrite).toHaveBeenCalledOnce();
    expect(atomicWrite).toHaveBeenCalledWith(path, `${JSON.stringify([validJob], null, 2)}\n`);
  });

  it("creates parent directories before writing", async () => {
    const atomicWrite = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => undefined);

    await saveJobs([], path, { atomicWrite, makeDirectory });

    expect(makeDirectory).toHaveBeenCalledOnce();
  });

  it("writes atomically to the real filesystem", async () => {
    await saveJobs([validJob], join(directory, "jobs.json"));
    const content = await readFile(join(directory, "jobs.json"), "utf8");
    expect(content).toBe(`${JSON.stringify([validJob], null, 2)}\n`);
  });
});

describe("validateJob", () => {
  it("accepts unique absolute required outputs", () => {
    expect(validateJob({ ...validJob, requiredOutputs: ["/tmp/result.md"] }, "/path").requiredOutputs)
      .toEqual(["/tmp/result.md"]);
  });

  it.each<string[]>([["relative.md"], ["/tmp/a", "/tmp/a"]])("rejects invalid required outputs: %j", requiredOutputs => {
    expect(() => validateJob({ ...validJob, requiredOutputs }, "/path")).toThrow(CronJobsError);
  });
  it("accepts a valid job", () => {
    expect(validateJob(validJob, "/path")).toMatchObject(validJob);
  });

  it("accepts lastRun as a number", () => {
    expect(validateJob({ ...validJob, lastRun: 1234567890 }, "/path")).toMatchObject({ lastRun: 1234567890 });
  });

  it("rejects a non-object", () => {
    expect(() => validateJob("string", "/path")).toThrow(CronJobsError);
  });

  it("rejects an empty id", () => {
    expect(() => validateJob({ ...validJob, id: "" }, "/path")).toThrow(CronJobsError);
  });

  it("rejects an invalid cron schedule", () => {
    expect(() => validateJob({ ...validJob, schedule: "bad" }, "/path")).toThrow(CronJobsError);
  });

  it("rejects an empty prompt", () => {
    expect(() => validateJob({ ...validJob, prompt: "" }, "/path")).toThrow(CronJobsError);
  });

  it("rejects a lastRun that is neither number nor null", () => {
    expect(() => validateJob({ ...validJob, lastRun: "yesterday" }, "/path")).toThrow(CronJobsError);
  });
});

describe("isDue", () => {
  // Use */1 * * * * (every minute) — minute-aligned, timezone-independent.
  // CronExpressionParser interprets expressions in local time; minute-level
  // schedules behave identically in any timezone.

  // Anchor: a minute boundary well in the past
  // We pick a wall-clock epoch that lands on :00 seconds, then work forward.
  const minuteJob = (lastRun: number | null): CronJob => ({
    id: "m",
    schedule: "*/1 * * * *",
    prompt: "x",
    lastRun,
  });

  // Compute the last scheduled minute-boundary before an arbitrary "now + 30s"
  const nowAtHalfMinute = (): { now: number; lastTick: number; prevTick: number } => {
    // Choose a "now" that is 30 seconds past a minute boundary
    const rawNow = Date.now();
    const lastTick = rawNow - (rawNow % 60_000); // most recent :00
    const prevTick = lastTick - 60_000;           // one minute before that
    const now = lastTick + 30_000;               // 30 seconds past lastTick
    return { now, lastTick, prevTick };
  };

  it("returns true when lastRun is null (never run)", () => {
    const { now } = nowAtHalfMinute();
    expect(isDue(minuteJob(null), now)).toBe(true);
  });

  it("returns true when lastRun is before the most recent scheduled tick", () => {
    const { now, lastTick, prevTick } = nowAtHalfMinute();
    // lastRun is prevTick (two minutes ago tick), lastTick has since passed → due
    expect(isDue(minuteJob(prevTick), now)).toBe(true);
  });

  it("returns false when lastRun is after the most recent scheduled tick", () => {
    const { now, lastTick } = nowAtHalfMinute();
    // lastRun is 5 seconds after the tick — already recorded
    expect(isDue(minuteJob(lastTick + 5_000), now)).toBe(false);
  });

  it("returns false when lastRun equals the most recent scheduled tick exactly", () => {
    const { now, lastTick } = nowAtHalfMinute();
    expect(isDue(minuteJob(lastTick), now)).toBe(false);
  });

  it("returns true when now is exactly at the scheduled tick and lastRun is null", () => {
    const rawNow = Date.now();
    const tick = rawNow - (rawNow % 60_000); // exact minute boundary
    expect(isDue(minuteJob(null), tick)).toBe(true);
  });

  it("returns false when now is before the scheduled tick (not yet due)", () => {
    // Construct: now = 5 seconds BEFORE the next tick, lastRun = the tick before that
    const rawNow = Date.now();
    const nextTick = rawNow - (rawNow % 60_000) + 60_000; // upcoming :00
    const now = nextTick - 5_000;                          // 5 seconds before it
    const prevOfNow = nextTick - 60_000;                   // the most recent past tick from `now`
    // After running at prevOfNow, isDue should be false
    expect(isDue(minuteJob(prevOfNow), now)).toBe(false);
  });

  it("is not due again after firing until the next interval elapses", () => {
    const { now, lastTick } = nowAtHalfMinute();
    // Fired at lastTick; should not be due again until lastTick + 60s
    expect(isDue(minuteJob(lastTick), now)).toBe(false);
    // One minute later (now + 31s = nextTick + 1s) it becomes due
    expect(isDue(minuteJob(lastTick), now + 31_000)).toBe(true);
  });
});
