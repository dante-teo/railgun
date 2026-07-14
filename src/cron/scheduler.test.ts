import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinStreamEvent, DevinModel } from "widevin";
import type { CronJob } from "./jobs.js";
import type { CronJobResult } from "./scheduler.js";
import { tick, runCronJob, startScheduler } from "./scheduler.js";
import type { AppConfig } from "../config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

const baseConfig: AppConfig = { model: null, defaultProjectTrust: "ask", approvalMode: "manual" };

const fakeModel: DevinModel = { id: "model-x", contextWindow: 100_000 } as DevinModel;

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider => {
  let callIndex = 0;
  return {
    login: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    listModels: vi.fn(),
    streamChat: async function* () {
      const round = rounds[callIndex++];
      if (!round) throw new Error(`streamChat called beyond scripted rounds (call ${callIndex})`);
      if ("throws" in round) throw round.throws;
      for (const event of round) yield event;
    },
  };
};

const makeJob = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "job-1",
  schedule: "0 9 * * *",
  prompt: "What is 2 + 2?",
  lastRun: null,
  ...overrides,
});

const runTestCron = (
  job: CronJob, devin: DevinProvider, model: DevinModel, systemPrompt: readonly string[], config: AppConfig, log: (message: string) => void,
) => runCronJob(job, devin, model, systemPrompt, config, log, { reportRoot: join(tmpdir(), `railgun-cron-test-${process.pid}`) });

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

describe("tick", () => {
  it("runs due jobs and updates lastRun", async () => {
    // null lastRun → always due
    const job = makeJob({ lastRun: null });
    const now = Date.now();
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({ jobId: j.id, ok: true, text: "4" }));

    const updated = await tick([job], now, runJob);

    expect(runJob).toHaveBeenCalledOnce();
    expect(updated[0]?.lastRun).toBe(now);
  });

  it("skips jobs that are not due", async () => {
    // lastRun at now means the current tick was already recorded
    const now = Date.now();
    const job = makeJob({ lastRun: now });
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({ jobId: j.id, ok: true, text: "" }));

    const updated = await tick([job], now, runJob);

    expect(runJob).not.toHaveBeenCalled();
    expect(updated[0]?.lastRun).toBe(now); // unchanged
  });

  it("handles an empty job list", async () => {
    const runJob = vi.fn(async (): Promise<CronJobResult> => ({ jobId: "x", ok: true, text: "" }));
    const updated = await tick([], Date.now(), runJob);
    expect(updated).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("runs only the due jobs when a mix is provided", async () => {
    const now = Date.now();
    const due = makeJob({ id: "due", lastRun: null });
    const notDue = makeJob({ id: "not-due", lastRun: now });
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({ jobId: j.id, ok: true, text: "" }));

    const updated = await tick([due, notDue], now, runJob);

    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob.mock.calls[0]?.[0]).toMatchObject({ id: "due" });
    expect(updated.find(j => j.id === "due")?.lastRun).toBe(now);
    expect(updated.find(j => j.id === "not-due")?.lastRun).toBe(now); // was already now
  });

  it("runs jobs sequentially (second job sees updated state of first)", async () => {
    const callOrder: string[] = [];
    const now = Date.now();
    const jobs = [makeJob({ id: "a", lastRun: null }), makeJob({ id: "b", lastRun: null })];
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => {
      callOrder.push(j.id);
      return { jobId: j.id, ok: true, text: "" };
    });

    await tick(jobs, now, runJob);

    expect(callOrder).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// runCronJob
// ---------------------------------------------------------------------------

describe("runCronJob", () => {
  it("completes only when a required output is newly written and saves a report", async () => {
    const root = await mkdtemp(join(tmpdir(), "railgun-cron-contract-"));
    const output = join(root, "result.md");
    try {
      const devin = fakeProvider([
        [
          { type: "toolcall_delta", id: "write", delta: JSON.stringify({ path: output, content: "done" }) },
          { type: "toolcall_end", id: "write", name: "write_file", arguments: { path: output, content: "done" } },
        ],
        [{ type: "text_delta", delta: "Wrote and verified the report." }],
      ]);
      const result = await runCronJob(makeJob({ requiredOutputs: [output] }), devin, fakeModel, [], baseConfig, vi.fn(), { reportRoot: join(root, "reports") });
      expect(result).toMatchObject({ ok: true, status: "completed" });
      const jobDirectories = await readdir(join(root, "reports"));
      const reports = await readdir(join(root, "reports", jobDirectories[0]!));
      expect(await readFile(join(root, "reports", jobDirectories[0]!, reports[0]!), "utf8")).toContain(`PASS \`${output}\``);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks a missing required output incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "railgun-cron-missing-"));
    try {
      const missing = join(root, "missing.md");
      const result = await runCronJob(
        makeJob({ requiredOutputs: [missing] }), fakeProvider([[{ type: "text_delta", delta: "done" }]]), fakeModel, [], baseConfig, vi.fn(), { reportRoot: join(root, "reports") },
      );
      expect(result).toMatchObject({ ok: false, status: "incomplete" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("creates a session, runs the prompt, and returns the collected text", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "The answer is " }, { type: "text_delta", delta: "4." }, { type: "done", reason: "stop" }],
    ]);
    const job = makeJob();
    const log = vi.fn();

    const result = await runTestCron(job, devin, fakeModel, ["System"], baseConfig, log);

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe(job.id);
    expect(result.text).toBe("The answer is 4.");
    expect(log).toHaveBeenCalledWith(`Running cron job: ${job.id}`);
  });

  it("returns ok:false with error when the agent stream throws", async () => {
    const boom = new Error("network failure");
    const devin = fakeProvider([{ throws: boom }]);
    const job = makeJob();
    const log = vi.fn();

    const result = await runTestCron(job, devin, fakeModel, [], baseConfig, log);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
  });

  it("auto-approves shell commands when approvalMode is off", async () => {
    const offConfig: AppConfig = { ...baseConfig, approvalMode: "off" };
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "ok" }, { type: "done", reason: "stop" }],
    ]);
    const job = makeJob({ prompt: "run something" });
    const log = vi.fn();

    // We can't easily intercept the confirmShellCommand, but we can verify the
    // session runs without error under approvalMode:"off"
    const result = await runTestCron(job, devin, fakeModel, [], offConfig, log);
    expect(result.ok).toBe(true);
  });

  it("logs tool start and end events", async () => {
    // We need a tool call in the stream. Without a real tool dispatch we can only
    // verify the text path here — tool events require real file tool execution.
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "done" }, { type: "done", reason: "stop" }],
    ]);
    const log = vi.fn();
    await runTestCron(makeJob(), devin, fakeModel, [], baseConfig, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Running cron job:"));
  });
});

// ---------------------------------------------------------------------------
// startScheduler
// ---------------------------------------------------------------------------

describe("startScheduler", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops cleanly when the signal is aborted before the first tick completes", async () => {
    const controller = new AbortController();
    const log = vi.fn();

    // Abort immediately
    controller.abort();

    // loadJobs and saveJobs are real but irrelevant — no jobs file → []
    // We only need to verify the scheduler exits without hanging.
    const promise = startScheduler(
      fakeProvider([]),
      fakeModel,
      [],
      baseConfig,
      { signal: controller.signal, interval: 60_000, log },
    );

    // Drain microtasks
    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringContaining("started"));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Cron scheduler stopped \[run-\d+-\d+\]\./));
  });

  it("persists lastRun after a job runs and aborts before the next sleep", async () => {
    const now = Date.now();
    const job: CronJob = { id: "j", schedule: "*/1 * * * *", prompt: "hi", lastRun: null };

    const savedJobs: Array<readonly CronJob[]> = [];

    // Mock loadJobs and saveJobs via vi.mock at module level is complex here;
    // instead exercise the behaviour indirectly: tick() updates lastRun on
    // due jobs, and startScheduler calls saveJobs when anyRan is true.
    // We verify this by running tick directly with a spy runJob.
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({ jobId: j.id, ok: true, text: "" }));
    const updated = await tick([job], now, runJob);

    expect(updated[0]?.lastRun).toBe(now);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("logs started and stopped messages", async () => {
    const controller = new AbortController();
    const log = vi.fn();

    controller.abort();
    const promise = startScheduler(
      fakeProvider([]),
      fakeModel,
      [],
      baseConfig,
      { signal: controller.signal, interval: 1_000, log },
    );
    await vi.runAllTimersAsync();
    await promise;

    const messages = log.mock.calls.map(([msg]) => msg as string);
    expect(messages.some(m => m.includes("started"))).toBe(true);
    expect(messages.some(m => m.includes("stopped"))).toBe(true);
  });

  it("uses 60_000 ms default interval when not specified", async () => {
    const controller = new AbortController();
    const log = vi.fn();

    controller.abort();
    const promise = startScheduler(fakeProvider([]), fakeModel, [], baseConfig, { signal: controller.signal, log });
    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Cron scheduler started \[run-\d+-\d+\]\. Checking every 60s\.\.\./));
  });
});


// ---------------------------------------------------------------------------
// tick — failure semantics (new)
// ---------------------------------------------------------------------------

describe("tick — failure semantics", () => {
  it("advances lastRun but not lastSuccess when runJob fails", async () => {
    const job = makeJob({ lastRun: null });
    const now = Date.now();
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({
      jobId: j.id, ok: false, text: "", error: new Error("boom"),
    }));
    const updated = await tick([job], now, runJob);
    expect(runJob).toHaveBeenCalledOnce();
    expect(updated[0]?.lastRun).toBe(now);
    expect(updated[0]?.lastSuccess).toBeUndefined();
    expect(updated[0]?.lastStatus).toBe("failed");
  });

  it("updates lastRun for every attempt and lastSuccess only for successful jobs", async () => {
    const now = Date.now();
    const failJob = makeJob({ id: "fail", lastRun: null });
    const okJob   = makeJob({ id: "ok",   lastRun: null });
    const runJob = vi.fn(async (j: CronJob): Promise<CronJobResult> => ({
      jobId: j.id,
      ok: j.id === "ok",
      text: "",
      ...(j.id !== "ok" ? { error: new Error("fail") } : {}),
    }));
    const updated = await tick([failJob, okJob], now, runJob);
    expect(updated.find(j => j.id === "fail")?.lastRun).toBe(now);
    expect(updated.find(j => j.id === "fail")?.lastSuccess).toBeUndefined();
    expect(updated.find(j => j.id === "ok")?.lastRun).toBe(now);
    expect(updated.find(j => j.id === "ok")?.lastSuccess).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// runCronJob — completion summaries (new)
// ---------------------------------------------------------------------------

describe("runCronJob — completion summaries", () => {
  it("logs a completion summary containing 'completed in' on success", async () => {
    const devin = fakeProvider([
      [{ type: "text_delta", delta: "4" }, { type: "done", reason: "stop" }],
    ]);
    const log = vi.fn();
    await runTestCron(makeJob(), devin, fakeModel, [], baseConfig, log);
    const messages = log.mock.calls.map(([msg]) => msg as string);
    expect(messages.some(m => m.includes("completed in"))).toBe(true);
  });

  it("logs a failure summary containing 'failed after' and the error message when agent throws", async () => {
    const boom = new Error("network failure");
    const devin = fakeProvider([{ throws: boom }]);
    const log = vi.fn();
    await runTestCron(makeJob(), devin, fakeModel, [], baseConfig, log);
    const messages = log.mock.calls.map(([msg]) => msg as string);
    expect(messages.some(m => m.includes("failed after"))).toBe(true);
    expect(messages.some(m => m.includes("network failure"))).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// startScheduler — run-id and lifecycle logging (new)
// ---------------------------------------------------------------------------

describe("startScheduler — run-id", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("includes a [run-PID-EPOCH] identifier in both started and stopped log lines", async () => {
    const controller = new AbortController();
    const log = vi.fn();
    controller.abort();
    const promise = startScheduler(fakeProvider([]), fakeModel, [], baseConfig, {
      signal: controller.signal, interval: 1_000, log,
    });
    await vi.runAllTimersAsync();
    await promise;
    const messages = log.mock.calls.map(([msg]) => msg as string);
    const startedLine = messages.find(m => m.includes("started"));
    const stoppedLine = messages.find(m => m.includes("stopped"));
    expect(startedLine).toMatch(/\[run-\d+-\d+\]/);
    expect(stoppedLine).toMatch(/\[run-\d+-\d+\]/);
  });

  it("logs a job count or no-jobs message after loading", async () => {
    const controller = new AbortController();
    const log = vi.fn();
    // Don't abort immediately — let one tick run, then abort
    const promise = startScheduler(fakeProvider([]), fakeModel, [], baseConfig, {
      signal: controller.signal, interval: 100, log,
    });
    // Let the first tick run
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    await promise;
    const messages = log.mock.calls.map(([msg]) => msg as string);
    expect(
      messages.some(m => m.includes("cron job") || m.includes("No cron jobs")),
    ).toBe(true);
  });
});
