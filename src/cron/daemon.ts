/**
 * Persistent cron daemon management.
 *
 * Supports two platforms:
 *   macOS  — launchd user agent (~/Library/LaunchAgents/<label>.plist)
 *   Linux  — systemd user service (~/.config/systemd/user/<name>.service)
 *
 * The daemon runs `railgun cron` in the background and is started at login /
 * on session open automatically by the OS service manager.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// ─── constants ────────────────────────────────────────────────────────────────

const LABEL = "sh.railgun.cron";
const SERVICE_NAME = "railgun-cron";

// ─── types ────────────────────────────────────────────────────────────────────

export type DaemonPlatform = "darwin" | "linux";

export interface DaemonStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly platform: DaemonPlatform;
  readonly serviceFile: string;
  /** Raw status text from launchctl / systemctl, or empty string. */
  readonly detail: string;
}

// ─── path helpers ─────────────────────────────────────────────────────────────

const plistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const systemdServicePath = (): string =>
  join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);

export const serviceFilePath = (p: DaemonPlatform = currentPlatform()): string =>
  p === "darwin" ? plistPath() : systemdServicePath();

export const currentPlatform = (): DaemonPlatform => {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  throw new Error(`Unsupported platform: ${p}. Only macOS and Linux are supported.`);
};

// ─── content generators ───────────────────────────────────────────────────────

/**
 * Returns the path to the installed `railgun` binary (process.argv[1]).
 * `cron install` is only meaningful when railgun is installed as a global
 * binary — not when run via `pnpm start` / `tsx`.
 */
export const resolveRailgunBin = (argv: readonly string[] = process.argv): string =>
  argv[1] ?? "";

/** Escape a string for safe embedding in an XML text node. */
const xmlEsc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const makePlist = (nodeBin: string, railgunBin: string): string => {
  const log = join(homedir(), ".railgun", "cron.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(nodeBin)}</string>
    <string>${xmlEsc(railgunBin)}</string>
    <string>cron</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEsc(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEsc(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEsc(homedir())}</string>
    <key>PATH</key>
    <string>${xmlEsc(process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
};

/** Escape a string for use as a systemd unit file value (double-quoted). */
const sdq = (s: string): string => `"${s.replaceAll('"', '\\"')}"`;

const makeSystemdService = (nodeBin: string, railgunBin: string): string => {
  const log = join(homedir(), ".railgun", "cron.log");
  return `[Unit]
Description=Railgun cron scheduler
After=network.target

[Service]
Type=simple
ExecStart=${sdq(nodeBin)} ${sdq(railgunBin)} cron
Restart=always
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}
Environment=${sdq(`HOME=${homedir()}`)}
Environment=${sdq(`PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`)}

[Install]
WantedBy=default.target
`;
};

// ─── platform operations ──────────────────────────────────────────────────────

const ensureLogDir = (): void => {
  mkdirSync(join(homedir(), ".railgun"), { recursive: true });
};

// macOS -----------------------------------------------------------------------

const darwinInstall = (nodeBin: string, railgunBin: string): void => {
  ensureLogDir();
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, makePlist(nodeBin, railgunBin), "utf8");
  // Unload first in case an old version is loaded (ignore errors)
  spawnSync("launchctl", ["unload", "-w", path]);
  const result = spawnSync("launchctl", ["load", "-w", path]);
  if (result.status !== 0) {
    throw new Error(`launchctl load failed: ${result.stderr?.toString().trim()}`);
  }
};

const darwinUninstall = (): void => {
  const path = plistPath();
  if (existsSync(path)) {
    spawnSync("launchctl", ["unload", "-w", path]);
    rmSync(path);
  }
};

const darwinStatus = (): DaemonStatus => {
  const path = plistPath();
  const installed = existsSync(path);
  let running = false;
  let detail = "";
  if (installed) {
    const result = spawnSync("launchctl", ["list", LABEL], { encoding: "utf8" });
    detail = (result.stdout ?? "").trim();
    // launchctl list exits 0 and prints a PID line when the job is running
    running = result.status === 0 && detail.length > 0 && !detail.includes('"PID" = 0');
  }
  return { installed, running, platform: "darwin", serviceFile: path, detail };
};

// Linux -----------------------------------------------------------------------

const linuxInstall = (nodeBin: string, railgunBin: string): void => {
  ensureLogDir();
  const path = systemdServicePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, makeSystemdService(nodeBin, railgunBin), "utf8");
  const daemon = spawnSync("systemctl", ["--user", "daemon-reload"]);
  if (daemon.status !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${daemon.stderr?.toString().trim()}`);
  }
  const enable = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  if (enable.status !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr?.toString().trim()}`);
  }
};

const linuxUninstall = (): void => {
  const path = systemdServicePath();
  if (existsSync(path)) {
    spawnSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    rmSync(path);
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  }
};

const linuxStatus = (): DaemonStatus => {
  const path = systemdServicePath();
  const installed = existsSync(path);
  let running = false;
  let detail = "";
  if (installed) {
    const result = spawnSync("systemctl", ["--user", "status", SERVICE_NAME], { encoding: "utf8" });
    detail = (result.stdout ?? "").trim();
    running = result.status === 0;
  }
  return { installed, running, platform: "linux", serviceFile: path, detail };
};

// ─── public API ──────────────────────────────────────────────────────────────

export const installDaemon = (
  p: DaemonPlatform = currentPlatform(),
  nodeBin: string = process.execPath,
  railgunBin: string = resolveRailgunBin(),
): void => {
  if (p === "darwin") darwinInstall(nodeBin, railgunBin);
  else linuxInstall(nodeBin, railgunBin);
};

export const uninstallDaemon = (p: DaemonPlatform = currentPlatform()): void => {
  if (p === "darwin") darwinUninstall();
  else linuxUninstall();
};

export const statusDaemon = (p: DaemonPlatform = currentPlatform()): DaemonStatus =>
  p === "darwin" ? darwinStatus() : linuxStatus();

export const formatStatus = (s: DaemonStatus): string => {
  const lines: string[] = [];
  lines.push(`Platform : ${s.platform === "darwin" ? "macOS (launchd)" : "Linux (systemd)"}`);
  lines.push(`Service  : ${s.serviceFile}`);
  lines.push(`Installed: ${s.installed ? "yes" : "no"}`);
  lines.push(`Running  : ${s.running ? "yes" : "no"}`);
  if (s.detail) {
    lines.push("---");
    lines.push(s.detail);
  }
  return lines.join("\n");
};
