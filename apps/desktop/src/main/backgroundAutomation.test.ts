import { describe, expect, it, vi } from "vitest";
import {
  automationLaunchAgentPaths,
  createBackgroundAutomationService,
  createUnavailableAutomationService,
  launchctlCommands,
  makeAutomationPlist,
  parseAutomationStatus,
  type AutomationRuntime,
} from "./backgroundAutomation";

const runtime: AutomationRuntime = {
  uid: 501,
  home: "/Users/railgun",
  executablePath: "/Applications/Railgun.app/Contents/MacOS/Railgun",
  backendEntry: "/Applications/Railgun.app/Contents/Resources/backend/railgun/dist/backend.js",
};

describe("background automation", () => {
  it("reports a stable unavailable state without permitting service mutations", async () => {
    const service = createUnavailableAutomationService("Install Railgun first.");
    await expect(service.getAutomationStatus()).resolves.toEqual({
      state: "unavailable",
      enabled: false,
      scheduler: "unavailable",
      dream: "unavailable",
      message: "Install Railgun first.",
    });
    await expect(service.enableAutomation()).rejects.toThrow("Install Railgun first.");
  });

  it("creates isolated scheduler and midnight Dream launch agents", () => {
    const paths = automationLaunchAgentPaths(runtime.home);
    expect(paths.scheduler).toBe("/Users/railgun/Library/LaunchAgents/sh.railgun.cron.plist");
    expect(makeAutomationPlist("scheduler", runtime)).toContain("<string>cron</string>");
    expect(makeAutomationPlist("scheduler", runtime)).not.toContain("<string>scheduler</string>");
    expect(makeAutomationPlist("scheduler", runtime)).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(makeAutomationPlist("scheduler", runtime)).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(makeAutomationPlist("dream", runtime)).toContain("<key>StartCalendarInterval</key>");
    expect(makeAutomationPlist("dream", runtime)).toContain("<integer>0</integer>");
    expect(makeAutomationPlist("dream", runtime)).not.toContain("<key>KeepAlive</key>");
    expect(makeAutomationPlist("dream", runtime)).not.toMatch(/<string>(?:railgun|pnpm|node)<\/string>/u);
  });

  it("uses the current GUI domain and safe launchctl lifecycle commands", () => {
    const paths = automationLaunchAgentPaths(runtime.home);
    expect(launchctlCommands("enable", runtime.uid, paths)).toEqual([
      ["bootout", "gui/501/sh.railgun.cron"],
      ["bootout", "gui/501/sh.railgun.dream"],
      ["bootstrap", "gui/501", paths.scheduler],
      ["bootstrap", "gui/501", paths.dream],
      ["kickstart", "-k", "gui/501/sh.railgun.cron"],
    ]);
    expect(launchctlCommands("disable", runtime.uid, paths)).toEqual([
      ["bootout", "gui/501/sh.railgun.cron"],
      ["bootout", "gui/501/sh.railgun.dream"],
    ]);
  });

  it("recognizes healthy, stale, and unavailable service definitions", () => {
    expect(parseAutomationStatus({
      scheduler: { file: true, print: "state = running\npath = /Applications/Railgun.app/Contents/MacOS/Railgun" },
      dream: { file: true, print: "state = waiting\npath = /Applications/Railgun.app/Contents/MacOS/Railgun" },
    }, runtime)).toMatchObject({ state: "enabled", enabled: true, scheduler: "running", dream: "waiting" });
    expect(parseAutomationStatus({
      scheduler: { file: true, print: "path = /Applications/Old Railgun.app/Contents/MacOS/Railgun" },
      dream: { file: true, print: "path = /Applications/Old Railgun.app/Contents/MacOS/Railgun" },
    }, runtime)).toMatchObject({ state: "repair-needed", enabled: true });
    expect(parseAutomationStatus({
      scheduler: { file: true, print: undefined }, dream: { file: true, print: undefined },
    }, runtime)).toMatchObject({ state: "unavailable", enabled: true });
  });

  it("atomically replaces only the two legacy Railgun labels before enabling", async () => {
    const writeAtomic = vi.fn(async () => {});
    const run = vi.fn<(args: readonly string[]) => Promise<{ status: number; stdout: string; stderr: string }>>(async () => ({ status: 0, stdout: "", stderr: "" }));
    const service = createBackgroundAutomationService(runtime, { writeAtomic, exists: vi.fn(() => true), run });
    await service.enableAutomation();
    expect(writeAtomic).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.slice(0, 5).map(call => call[0])).toEqual(launchctlCommands("enable", runtime.uid, automationLaunchAgentPaths(runtime.home)));
    expect(run.mock.calls.flat().join(" ")).not.toContain("other.agent");
  });
});
