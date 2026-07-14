import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock homedir() so daemon.ts builds all paths under a temp dir instead of ~/
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

// Mock spawnSync so no real OS service manager is invoked.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] })),
}));

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  currentPlatform,
  formatStatus,
  installDaemon,
  resolveRailgunBin,
  serviceFilePath,
  statusDaemon,
  uninstallDaemon,
} from "./daemon.js";
import type { DaemonStatus } from "./daemon.js";

const nodeBin = "/fake/node";
const railgunBin = "/fake/railgun";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "railgun-daemon-home-"));
  vi.mocked(homedir).mockReturnValue(tmpHome);
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] });
});

afterEach(async () => {
  vi.mocked(spawnSync).mockReset();
  vi.mocked(homedir).mockReset();
  await rm(tmpHome, { recursive: true, force: true });
});

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("formatStatus", () => {
  it("formats a darwin installed+running status with detail", () => {
    const s: DaemonStatus = {
      platform: "darwin",
      serviceFile: "/tmp/test.plist",
      logDir: "/tmp/.railgun/cron/logs",
      installed: true,
      running: true,
      detail: "PID = 42",
    };
    const out = formatStatus(s);
    expect(out).toContain("macOS (launchd)");
    expect(out).toContain("/tmp/test.plist");
    expect(out).toContain("Installed: yes");
    expect(out).toContain("Running  : yes");
    expect(out).toContain("PID = 42");
  });

  it("formats a linux not-installed status without detail section", () => {
    const s: DaemonStatus = {
      platform: "linux",
      serviceFile: "/home/user/.config/systemd/user/railgun-cron.service",
      logDir: "/home/user/.railgun/cron/logs",
      installed: false,
      running: false,
      detail: "",
    };
    const out = formatStatus(s);
    expect(out).toContain("Linux (systemd)");
    expect(out).toContain("Installed: no");
    expect(out).toContain("Running  : no");
    expect(out).not.toContain("---");
  });

  it("omits the detail section when detail is empty", () => {
    const s: DaemonStatus = { platform: "darwin", serviceFile: "/x.plist", logDir: "/tmp/.railgun/cron/logs", installed: true, running: false, detail: "" };
    expect(formatStatus(s)).not.toContain("---");
  });

  it("includes a Logs line showing the cron logs directory", () => {
    const s: DaemonStatus = { platform: "darwin", serviceFile: "/x.plist", logDir: "/home/.railgun/cron/logs", installed: true, running: true, detail: "" };
    const out = formatStatus(s);
    expect(out).toContain("Logs");
    expect(out).toContain("cron/logs");
  });
});

describe("serviceFilePath", () => {
  it("returns a .plist path under <home>/Library/LaunchAgents for darwin", () => {
    const p = serviceFilePath("darwin");
    expect(p).toContain("LaunchAgents");
    expect(p).toMatch(/\.plist$/);
    expect(p).toContain(tmpHome);
  });

  it("returns a .service path under <home>/.config/systemd/user for linux", () => {
    const p = serviceFilePath("linux");
    expect(p).toContain("systemd");
    expect(p).toMatch(/\.service$/);
    expect(p).toContain(tmpHome);
  });
});

describe("resolveRailgunBin", () => {
  it("returns argv[1] for a globally installed binary", () => {
    expect(resolveRailgunBin(["/usr/bin/node", "/usr/local/bin/railgun"])).toBe("/usr/local/bin/railgun");
  });

  it("returns argv[1] even when later args look like a cli entry point", () => {
    // installDaemon only supports globally installed railgun — argv[1] is always used.
    const argv = ["/usr/bin/node", "/usr/local/bin/railgun", "/some/src/cli.ts"];
    expect(resolveRailgunBin(argv)).toBe("/usr/local/bin/railgun");
  });

  it("returns empty string when argv is empty", () => {
    expect(resolveRailgunBin([])).toBe("");
  });
});

describe("currentPlatform", () => {
  it("returns darwin or linux", () => {
    expect(["darwin", "linux"]).toContain(currentPlatform());
  });
});

// ─── install — darwin ─────────────────────────────────────────────────────────

describe("installDaemon — darwin", () => {
  it("writes a plist containing the node bin, railgun bin, and 'cron' arg under tmpHome", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    const plist = serviceFilePath("darwin");
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toContain(nodeBin);
    expect(content).toContain(railgunBin);
    expect(content).toContain("<string>cron</string>");
    expect(content).toContain("RunAtLoad");
    expect(content).toContain("KeepAlive");
    expect(content).toContain(tmpHome);   // log path and HOME env both use tmpHome
  });

  it("calls launchctl load after writing the plist", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    const loadCall = vi.mocked(spawnSync).mock.calls.find(
      c => c[0] === "launchctl" && (c[1] as string[]).includes("load"),
    );
    expect(loadCall).toBeDefined();
  });

  it("throws when launchctl load exits non-zero", () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      if ((args as string[]).includes("load")) {
        return { status: 1, stdout: "", stderr: Buffer.from("permission denied"), pid: 0, signal: null, output: [] };
      }
      return { status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] };
    });
    expect(() => installDaemon("darwin", nodeBin, railgunBin)).toThrow(/launchctl load failed/);
  });

  it("XML-escapes & and < in paths so the plist stays valid", () => {
    installDaemon("darwin", "/tmp/A&B/node", "/tmp/A<B/railgun");
    const content = readFileSync(serviceFilePath("darwin"), "utf8");
    expect(content).toContain("<string>/tmp/A&amp;B/node</string>");
    expect(content).toContain("<string>/tmp/A&lt;B/railgun</string>");
    expect(content).not.toContain("&B");
    expect(content).not.toContain("<B");
  });
  it("StandardOutPath and StandardErrorPath are both /dev/null", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    const content = readFileSync(serviceFilePath("darwin"), "utf8");
    // Both keys must be /dev/null — toContain alone only checks one occurrence
    expect(content).toContain("<key>StandardOutPath</key>\n  <string>/dev/null</string>");
    expect(content).toContain("<key>StandardErrorPath</key>\n  <string>/dev/null</string>");
    expect(content).not.toContain("cron.log");
  });
});

// ─── uninstall — darwin ───────────────────────────────────────────────────────

describe("uninstallDaemon — darwin", () => {
  it("calls launchctl unload and removes the plist", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockClear();

    uninstallDaemon("darwin");

    expect(existsSync(serviceFilePath("darwin"))).toBe(false);
    const unloadCall = vi.mocked(spawnSync).mock.calls.find(
      c => c[0] === "launchctl" && (c[1] as string[]).includes("unload"),
    );
    expect(unloadCall).toBeDefined();
  });

  it("is a no-op when the plist does not exist", () => {
    uninstallDaemon("darwin");
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});

// ─── uninstall — linux (order matters) ───────────────────────────────────────

describe("uninstallDaemon — linux: systemctl call order", () => {
  it("removes the unit file before calling daemon-reload", () => {
    installDaemon("linux", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockClear();

    let fileExistedAtDisable: boolean | undefined;
    let fileExistedAtReload: boolean | undefined;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argv = args as string[];
      const filePath = serviceFilePath("linux");
      if (argv.includes("disable")) fileExistedAtDisable = existsSync(filePath);
      if (argv.includes("daemon-reload")) fileExistedAtReload = existsSync(filePath);
      return { status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] };
    });

    uninstallDaemon("linux");

    expect(fileExistedAtDisable).toBe(true);   // file still present when disable runs
    expect(fileExistedAtReload).toBe(false);   // file already gone when daemon-reload runs
    expect(existsSync(serviceFilePath("linux"))).toBe(false); // final state
  });

  it("is a no-op when the service file does not exist", () => {
    uninstallDaemon("linux");
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});

// ─── status — darwin ──────────────────────────────────────────────────────────

describe("statusDaemon — darwin", () => {
  it("returns installed:false, running:false when plist absent", () => {
    const s = statusDaemon("darwin");
    expect(s.installed).toBe(false);
    expect(s.running).toBe(false);
    expect(s.platform).toBe("darwin");
  });

  it("returns installed:true, running:true when launchctl reports a live PID", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: '{\n\t"PID" = 42;\n}', stderr: "", pid: 0, signal: null, output: [],
    });
    const s = statusDaemon("darwin");
    expect(s.installed).toBe(true);
    expect(s.running).toBe(true);
  });

  it("returns installed:true, running:false when launchctl reports PID=0", () => {
    installDaemon("darwin", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: '{\n\t"PID" = 0;\n}', stderr: "", pid: 0, signal: null, output: [],
    });
    const s = statusDaemon("darwin");
    expect(s.installed).toBe(true);
    expect(s.running).toBe(false);
  });
});

// ─── install — linux ──────────────────────────────────────────────────────────

describe("installDaemon — linux", () => {
  it("writes a systemd unit file containing the node bin, railgun bin, and 'cron' in ExecStart", () => {
    installDaemon("linux", nodeBin, railgunBin);
    const svcFile = serviceFilePath("linux");
    expect(existsSync(svcFile)).toBe(true);
    const content = readFileSync(svcFile, "utf8");
    expect(content).toContain(`ExecStart="${nodeBin}" "${railgunBin}" cron`);
    expect(content).toContain("Restart=always");
    expect(content).toContain("WantedBy=default.target");
    expect(content).toContain(tmpHome);
  });

  it("calls systemctl daemon-reload then enable --now", () => {
    installDaemon("linux", nodeBin, railgunBin);
    const calls = vi.mocked(spawnSync).mock.calls;
    const reloadIdx = calls.findIndex(c => (c[1] as string[]).includes("daemon-reload"));
    const enableIdx = calls.findIndex(c => (c[1] as string[]).includes("enable"));
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    expect(enableIdx).toBeGreaterThan(reloadIdx);
  });

  it("throws when systemctl daemon-reload exits non-zero", () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      if ((args as string[]).includes("daemon-reload")) {
        return { status: 1, stdout: "", stderr: Buffer.from("unit error"), pid: 0, signal: null, output: [] };
      }
      return { status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] };
    });
    expect(() => installDaemon("linux", nodeBin, railgunBin)).toThrow(/daemon-reload failed/);
  });

  it("throws when systemctl enable exits non-zero", () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      if ((args as string[]).includes("enable")) {
        return { status: 1, stdout: "", stderr: Buffer.from("enable error"), pid: 0, signal: null, output: [] };
      }
      return { status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [] };
    });
    expect(() => installDaemon("linux", nodeBin, railgunBin)).toThrow(/enable failed/);
  });

  it("quotes ExecStart tokens and Environment values so paths with spaces are safe", () => {
    const spaceyNode = "/usr/local/my node/bin/node";
    const spaceyBin  = '/home/user/my projects/railgun/dist/cli.js';
    installDaemon("linux", spaceyNode, spaceyBin);
    const content = readFileSync(serviceFilePath("linux"), "utf8");
    expect(content).toContain(`ExecStart="${spaceyNode}" "${spaceyBin}" cron`);
    expect(content).toMatch(/Environment="HOME=/);
    expect(content).toMatch(/Environment="PATH=/);
  });

  it("StandardOutput and StandardError use the systemd 'null' keyword", () => {
    installDaemon("linux", nodeBin, railgunBin);
    const content = readFileSync(serviceFilePath("linux"), "utf8");
    expect(content).toContain("StandardOutput=null");
    expect(content).toContain("StandardError=null");
    expect(content).not.toContain("cron.log");
    // Must not use bare /dev/null path — systemd expects the 'null' keyword
    expect(content).not.toContain("StandardOutput=/dev/null");
  });
});

// ─── status — linux ───────────────────────────────────────────────────────────

describe("statusDaemon — linux", () => {
  it("returns installed:false, running:false when service file absent", () => {
    const s = statusDaemon("linux");
    expect(s.installed).toBe(false);
    expect(s.running).toBe(false);
    expect(s.platform).toBe("linux");
  });

  it("returns installed:true, running:true when systemctl status exits 0", () => {
    installDaemon("linux", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: "Active: active (running)", stderr: "", pid: 0, signal: null, output: [],
    });
    const s = statusDaemon("linux");
    expect(s.installed).toBe(true);
    expect(s.running).toBe(true);
    expect(s.detail).toContain("active (running)");
  });

  it("returns installed:true, running:false when systemctl status exits non-zero", () => {
    installDaemon("linux", nodeBin, railgunBin);
    vi.mocked(spawnSync).mockReturnValue({
      status: 3, stdout: "Active: inactive (dead)", stderr: "", pid: 0, signal: null, output: [],
    });
    const s = statusDaemon("linux");
    expect(s.installed).toBe(true);
    expect(s.running).toBe(false);
  });
});
