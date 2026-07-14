import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

interface FileSnapshot { readonly fingerprint: string | null }
export type OutputSnapshots = Readonly<Record<string, FileSnapshot>>;
export interface OutputVerification { readonly path: string; readonly satisfied: boolean; readonly reason: string }

const fingerprint = async (path: string): Promise<string | null> => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const content = await readFile(path);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const snapshotOutputs = async (paths: readonly string[]): Promise<OutputSnapshots> =>
  Object.freeze(Object.fromEntries(await Promise.all(paths.map(async path => [path, { fingerprint: await fingerprint(path) }]))));

export const verifyOutputs = async (paths: readonly string[], before: OutputSnapshots): Promise<readonly OutputVerification[]> =>
  Promise.all(paths.map(async path => {
    try {
      const info = await stat(path);
      if (!info.isFile()) return { path, satisfied: false, reason: "not a regular file" };
      if (info.size === 0) return { path, satisfied: false, reason: "empty" };
      const after = await fingerprint(path);
      if (after === before[path]?.fingerprint) return { path, satisfied: false, reason: "unchanged" };
      return { path, satisfied: true, reason: "changed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, satisfied: false, reason: "missing" };
      return { path, satisfied: false, reason: `verification error: ${String(error)}` };
    }
  }));

const safeSlug = (id: string): string => id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "job";
export const reportDirectory = (root: string, jobId: string): string =>
  join(root, `${safeSlug(jobId)}-${createHash("sha256").update(jobId).digest("hex").slice(0, 8)}`);

export interface RunReport {
  readonly jobId: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly status: "completed" | "incomplete" | "failed";
  readonly durationMs: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly verification: readonly OutputVerification[];
  readonly finalResponse: string;
  readonly failureReason: string | null;
  readonly timestamp: Date;
}

const renderReport = (report: RunReport): string => [
  `# Cron run: ${report.jobId}`,
  "", `- Schedule: ${report.schedule}`, `- Status: ${report.status}`,
  `- Timestamp: ${report.timestamp.toISOString()}`, `- Duration: ${report.durationMs}ms`,
  `- Turns: ${report.turnCount}`, `- Tool calls: ${report.toolCallCount}`,
  "", "## Prompt", "", report.prompt,
  "", "## Required output verification", "",
  ...(report.verification.length === 0 ? ["No required outputs declared."] : report.verification.map(item => `- ${item.satisfied ? "PASS" : "FAIL"} \`${item.path}\`: ${item.reason}`)),
  "", "## Final response", "", report.finalResponse || "_(empty)_",
  "", "## Failure reason", "", report.failureReason ?? "None.", "",
].join("\n");

export const writeRunReport = async (root: string, report: RunReport): Promise<string> => {
  const directory = reportDirectory(root, report.jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${report.timestamp.toISOString().replace(/[:]/g, "-")}-${randomUUID().slice(0, 8)}.md`;
  const path = join(directory, filename);
  await writeFileAtomic(path, renderReport(report), { encoding: "utf8", mode: 0o600 });
  const reports = (await readdir(directory)).filter(name => name.endsWith(".md")).sort().reverse();
  await Promise.all(reports.slice(50).map(name => rm(join(directory, name))));
  return path;
};
