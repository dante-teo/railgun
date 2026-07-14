import { describe, expect, it, vi } from "vitest";
import { createMutationQueue } from "./mutationQueue";
import { createCronService } from "./cronService";

describe("desktop cron service", () => {
  it("uses cron RPC commands and projects renderer-safe jobs", async () => {
    const call = vi.fn(async (command: { type: string; [key: string]: unknown }) => command.type === "cron_list"
      ? { jobs: [{ id: "job-1", schedule: "0 9 * * 1-5", prompt: "Plan the day" }] }
      : command.type === "cron_remove" ? undefined
        : { jobId: "job-1" });
    const service = createCronService((command, validate) => call(command).then(validate), createMutationQueue());

    const jobs = await service.list();
    expect(jobs).toEqual([expect.objectContaining({ id: "job-1", schedule: "0 9 * * 1-5", prompt: "Plan the day", summary: expect.any(String) })]);
    expect(jobs[0]).not.toHaveProperty("lastRun");
    expect(call).toHaveBeenCalledWith({ type: "cron_list", cursor: 0, limit: 1, editableOnly: true, maxPromptLength: 8_000 });
    await expect(service.create({ schedule: " 0  10 * * 1-5 ", prompt: " Updated " })).resolves.toMatchObject({ schedule: "0 10 * * 1-5", prompt: "Updated" });
    expect(call).toHaveBeenCalledWith({ type: "cron_add", schedule: "0 10 * * 1-5", prompt: "Updated", includeJob: false });
    await service.update("job-1", { schedule: "0 10 * * 1-5", prompt: "Updated" });
    expect(call).toHaveBeenCalledWith({ type: "cron_update", jobId: "job-1", patch: { schedule: "0 10 * * 1-5", prompt: "Updated" }, includeJob: false });
    await expect(service.delete("job-1")).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith({ type: "cron_remove", jobId: "job-1" });
  });

  it("rejects malformed results and propagates RPC errors", async () => {
    const malformed = createCronService(async (_command, validate) => validate({ jobs: [{ id: "job", schedule: "61 * * * *", prompt: "No" }] }), createMutationQueue());
    await expect(malformed.list()).rejects.toThrow(/invalid cron schedule/iu);
    const failed = createCronService(async () => { throw new Error("store unavailable"); }, createMutationQueue());
    await expect(failed.create({ schedule: "0 9 * * *", prompt: "Run" })).rejects.toThrow("store unavailable");

    const mismatched = createCronService(async (_command, validate) => validate({ jobId: "other" }), createMutationQueue());
    await expect(mismatched.update("expected", { schedule: "0 9 * * *", prompt: "Run" })).rejects.toThrow(/mismatched cron job/iu);
  });

  it("serializes mutations through the provided shared queue", async () => {
    const queue = createMutationQueue();
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    const call = vi.fn(async (_command: unknown) => ({ jobId: "job" }));
    const service = createCronService((command, validate) => call(command).then(validate), queue);
    const creation = service.create({ schedule: "0 9 * * *", prompt: "Run" });
    await Promise.resolve();
    expect(call).not.toHaveBeenCalled();
    release();
    await first;
    await creation;
    expect(call).toHaveBeenCalledOnce();
  });
});
