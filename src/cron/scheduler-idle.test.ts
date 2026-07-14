/**
 * Regression test for the anyDue idle-log fix.
 *
 * Uses its own file so there is no top-level static import of ./scheduler.js.
 * vi.doMock must be called before any import of the module under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevinProvider, DevinStreamEvent, DevinModel } from "widevin";
import type { AppConfig } from "../config.js";
import type { CronJob } from "./jobs.js";

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

describe("startScheduler — idle log suppression", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("does not log 'No jobs due' when a due job fails", async () => {
    // A due job (lastRun:null) whose provider throws → runCronJob returns ok:false.
    // Before the anyDue fix, startScheduler emitted 'No jobs due' because anyRan
    // (based on lastRun changes) was false even though a job was attempted.
    const dueJob = makeJob({ id: "fail-job", lastRun: null });
    vi.resetModules();

    const saveJobsMock = vi.fn(async () => {});
    vi.doMock("./jobs.js", () => ({
      loadJobs: vi.fn(async () => [dueJob]),
      saveJobs: saveJobsMock,
      isDue: (job: CronJob) => job.lastRun === null,
    }));

    // Dynamic import AFTER doMock so the fresh module picks up the mock.
    const { startScheduler } = await import("./scheduler.js");

    const controller = new AbortController();
    const log = vi.fn();

    const promise = startScheduler(
      fakeProvider([{ throws: new Error("network failure") }]),
      fakeModel,
      [],
      baseConfig,
      { signal: controller.signal, interval: 100, log },
    );

    // Let one tick run then abort.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    await promise;

    const messages = log.mock.calls.map(([msg]) => msg as string);
    // anyDue=true → idle branch never entered, no "No jobs due" emitted
    expect(messages.some(m => m.includes("No jobs due"))).toBe(false);
    // runCronJob logged the failure
    expect(messages.some(m => m.includes("failed after"))).toBe(true);
    // anySucceeded=false → saveJobs must not be called
    expect(saveJobsMock).not.toHaveBeenCalled();
  });
});
