import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const LABEL = "sh.railgun.cron";

export type DaemonPlatform = "darwin";

export interface DaemonStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly platform: DaemonPlatform;
  readonly serviceFile: string;
  readonly logDir: string;
  readonly detail: string;
}

export const currentPlatform = (): DaemonPlatform => {
  if (platform() !== "darwin") throw new Error("Railgun scheduling is available only on macOS.");
  return "darwin";
};

export const serviceFilePath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export const statusDaemon = (): DaemonStatus => {
  const serviceFile = serviceFilePath();
  const installed = existsSync(serviceFile);
  let running = false;
  let detail = "";
  if (installed) {
    const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf8" });
    detail = (result.stdout ?? "").trim();
    running = result.status === 0 && detail.length > 0 && !detail.includes('"PID" = 0');
  }
  return {
    installed,
    running,
    platform: currentPlatform(),
    serviceFile,
    logDir: join(homedir(), ".railgun", "cron", "logs"),
    detail,
  };
};
