import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportDirectory, snapshotOutputs, verifyOutputs, writeRunReport } from "./artifacts.js";

describe("cron output contracts", () => {
  it("requires a newly changed, non-empty regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "railgun-output-"));
    try {
      const path = join(dir, "result.md");
      const before = await snapshotOutputs([path]);
      await writeFile(path, "done");
      expect((await verifyOutputs([path], before))[0]).toMatchObject({ satisfied: true });
      const unchanged = await snapshotOutputs([path]);
      expect((await verifyOutputs([path], unchanged))[0]).toMatchObject({ satisfied: false, reason: "unchanged" });
      await writeFile(path, "");
      expect((await verifyOutputs([path], before))[0]).toMatchObject({ satisfied: false, reason: "empty" });
      await rm(path);
      await mkdir(path);
      expect((await verifyOutputs([path], before))[0]).toMatchObject({ satisfied: false, reason: "not a regular file" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("cron reports", () => {
  it("uses a contained sanitized directory and retains the newest 50 reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "railgun-reports-"));
    try {
      const directory = reportDirectory(root, "../../escape");
      expect(directory.startsWith(`${root}/`)).toBe(true);
      for (let index = 0; index < 52; index += 1) {
        await writeRunReport(root, {
          jobId: "../../escape", schedule: "* * * * *", prompt: "go", status: "completed",
          durationMs: 1, turnCount: 1, toolCallCount: 0, verification: [], finalResponse: "done",
          failureReason: null, timestamp: new Date(1_700_000_000_000 + index),
        });
      }
      const files = await import("node:fs/promises").then(fs => fs.readdir(directory));
      expect(files).toHaveLength(50);
      expect(await readFile(join(directory, files.at(-1)!), "utf8")).toContain("Status: completed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
