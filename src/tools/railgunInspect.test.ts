import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createRuntimeContext } from "../runtime.js";
import { reportDirectory } from "../cron/artifacts.js";
import { inspectRailgun, redactConfig } from "./railgunInspect.js";

const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "railgun-inspect-"));
  return { home, runtime: createRuntimeContext("interactive", home) };
};

describe("railgun_inspect", () => {
  it("redacts secret keys and every MCP environment value", () => {
    const redacted = redactConfig({
      token: "secret",
      unknown: 7,
      mcpServers: {
        docs: {
          env: { SAFE_NAME: "also-secret" },
          command: "docs",
          args: ["--token", "secret-value", "--api-key=inline-secret", "--password combined-secret", "--header", "Authorization: Bearer header-secret", "ordinary"],
        },
      },
    });
    expect(redacted).toEqual({
      token: "[REDACTED]",
      unknown: 7,
      mcpServers: {
        docs: {
          env: { SAFE_NAME: "[REDACTED]" },
          command: "docs",
          args: ["--token", "[REDACTED]", "--api-key=[REDACTED]", "--password [REDACTED]", "--header", "Authorization: [REDACTED]", "ordinary"],
        },
      },
    });
  });

  it("returns effective validated config without credentials and reports malformed JSON", async () => {
    const { runtime } = await fixture();
    await mkdir(runtime.home, { recursive: true });
    await writeFile(runtime.paths.config, JSON.stringify({
      model: null,
      unknown: true,
      apiKey: "hidden",
      mcpServers: { x: { args: ["--token", "argument-hidden", "ordinary"], env: { PUBLIC: "hidden-too" } } },
    }));
    const result = await inspectRailgun({ area: "config" }, { runtime });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"unknown": true');
    expect(result.content).toContain('"ordinary"');
    expect(result.content).not.toContain("hidden");
    await writeFile(runtime.paths.config, "{");
    expect((await inspectRailgun({ area: "config" }, { runtime })).isError).toBe(true);
  });

  it("bounds selected log tails by lines and bytes", async () => {
    const { runtime } = await fixture();
    await mkdir(runtime.paths.interactiveLogs, { recursive: true });
    await writeFile(join(runtime.paths.interactiveLogs, "interactive-latest.jsonl"), `${Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n")}\n`);
    const result = await inspectRailgun({ area: "logs", source: "interactive", limit: 3 }, { runtime });
    const parsed = JSON.parse(result.content) as { lines: string[]; truncated: boolean };
    expect(parsed.lines).toEqual(["line-297", "line-298", "line-299"]);
    expect(parsed.truncated).toBe(true);
  });

  it("normalizes cron health and safely resolves bounded reports", async () => {
    const { runtime } = await fixture();
    await mkdir(join(runtime.home, "cron"), { recursive: true });
    await writeFile(runtime.paths.cron, JSON.stringify([{ id: "daily/unsafe", schedule: "0 1 * * *", prompt: "work", lastRun: 2, lastSuccess: 1, lastStatus: "failed", lastError: "boom" }]));
    const health = await inspectRailgun({ area: "cron" }, { runtime, daemonStatus: () => ({ installed: true, running: false, platform: "darwin", serviceFile: "service", logDir: "logs", detail: "" }) });
    expect(JSON.parse(health.content).jobs[0]).toMatchObject({ id: "daily/unsafe", lastStatus: "failed", lastError: "boom" });

    const directory = reportDirectory(runtime.paths.cronOutput, "daily/unsafe");
    await mkdir(directory, { recursive: true });
    const report = "2026-01-01T00-00-00.000Z-aaaa.md";
    await writeFile(join(directory, report), `# Cron run\n\n- Status: failed\n- Timestamp: 2026-01-01T00:00:00.000Z\n- Duration: 1ms\n\n## Prompt\n\n${"large prompt\n".repeat(7_000)}\n## Failure reason\n\nboom\n`);
    const summaries = await inspectRailgun({ area: "cron_runs", job_id: "daily/unsafe" }, { runtime });
    expect(summaries.content).toContain(report);
    expect(JSON.parse(summaries.content).reports[0]).toMatchObject({ status: "failed", failureReason: "boom" });
    const full = await inspectRailgun({ area: "cron_runs", job_id: "daily/unsafe", detail: "full", report }, { runtime });
    expect(JSON.parse(full.content).text).toContain("[... report truncated ...]");
    expect(JSON.parse(full.content).text).toContain("# Cron run");
    expect(JSON.parse(full.content).text).toContain("boom");
    expect((await inspectRailgun({ area: "cron_runs", job_id: "daily/unsafe", detail: "full", report: "../../config.json" }, { runtime })).isError).toBe(true);
    expect(await readFile(join(directory, report), "utf8")).toContain("boom");
  });
});
