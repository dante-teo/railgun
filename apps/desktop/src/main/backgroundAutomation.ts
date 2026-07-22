import { execFile } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const AUTOMATION_LABELS = Object.freeze({
  scheduler: "sh.railgun.cron",
  dream: "sh.railgun.dream",
});

export type AutomationKind = keyof typeof AUTOMATION_LABELS;
export type AutomationState = "disabled" | "enabled" | "repair-needed" | "unavailable";
export type AutomationServiceState = "running" | "waiting" | "stopped" | "unavailable";

export interface AutomationRuntime {
  readonly uid: number;
  readonly home: string;
  readonly executablePath: string;
  readonly backendEntry: string;
}

export interface AutomationStatus {
  readonly state: AutomationState;
  readonly enabled: boolean;
  readonly scheduler: AutomationServiceState;
  readonly dream: AutomationServiceState;
  readonly message: string;
}

export interface AutomationPaths {
  readonly scheduler: string;
  readonly dream: string;
}

const unavailableStatus = (message: string): AutomationStatus => ({
  state: "unavailable",
  enabled: false,
  scheduler: "unavailable",
  dream: "unavailable",
  message,
});

export const createUnavailableAutomationService = (message: string) => {
  const unavailable = async (): Promise<never> => { throw new Error(message); };
  return {
    getAutomationStatus: async (): Promise<AutomationStatus> => unavailableStatus(message),
    enableAutomation: unavailable,
    disableAutomation: unavailable,
    repairAutomation: unavailable,
  };
};

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface AutomationDependencies {
  readonly writeAtomic?: (path: string, content: string) => Promise<void>;
  readonly exists?: (path: string) => boolean | Promise<boolean>;
  readonly remove?: (path: string) => Promise<void>;
  readonly run?: (args: readonly string[]) => Promise<CommandResult>;
}

const xml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const stringList = (values: readonly string[]): string => values.map(value => `    <string>${xml(value)}</string>`).join("\n");

const serviceState = (print: string | undefined): AutomationServiceState => {
  if (print === undefined) return "unavailable";
  const state = /\bstate = ([a-z-]+)/u.exec(print)?.[1];
  if (state === "running") return "running";
  if (state === "waiting") return "waiting";
  return "stopped";
};

export const automationLaunchAgentPaths = (home: string): AutomationPaths => {
  const directory = join(home, "Library", "LaunchAgents");
  return {
    scheduler: join(directory, `${AUTOMATION_LABELS.scheduler}.plist`),
    dream: join(directory, `${AUTOMATION_LABELS.dream}.plist`),
  };
};

export const makeAutomationPlist = (kind: AutomationKind, runtime: AutomationRuntime): string => {
  const label = AUTOMATION_LABELS[kind];
  const command = kind === "scheduler" ? "cron" : "dream";
  const argumentsList = stringList([runtime.executablePath, runtime.backendEntry, command]);
  const schedule = kind === "scheduler"
    ? "  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>"
    : "  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>0</integer>\n    <key>Minute</key>\n    <integer>0</integer>\n  </dict>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
${schedule}
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>HOME</key>
    <string>${xml(runtime.home)}</string>
  </dict>
</dict>
</plist>
`;
};

export const launchctlCommands = (
  action: "enable" | "disable",
  uid: number,
  paths: AutomationPaths,
): readonly (readonly string[])[] => {
  const domain = `gui/${uid}`;
  const schedulerTarget = `${domain}/${AUTOMATION_LABELS.scheduler}`;
  const dreamTarget = `${domain}/${AUTOMATION_LABELS.dream}`;
  const bootout = [["bootout", schedulerTarget], ["bootout", dreamTarget]] as const;
  return action === "disable" ? bootout : [
    ...bootout,
    ["bootstrap", domain, paths.scheduler],
    ["bootstrap", domain, paths.dream],
    ["kickstart", "-k", schedulerTarget],
  ];
};

export const parseAutomationStatus = (
  services: Readonly<Record<AutomationKind, { readonly file: boolean; readonly print: string | undefined }>>,
  runtime: AutomationRuntime,
): AutomationStatus => {
  const installed = services.scheduler.file || services.dream.file;
  if (!installed) return { state: "disabled", enabled: false, scheduler: "stopped", dream: "stopped", message: "Background automation is off." };
  const scheduler = serviceState(services.scheduler.print);
  const dream = serviceState(services.dream.print);
  if (services.scheduler.print === undefined || services.dream.print === undefined) {
    return { state: "unavailable", enabled: true, scheduler, dream, message: "Launchd could not load background automation. Repair it to use this app location." };
  }
  const expected = runtime.executablePath;
  if (!services.scheduler.print.includes(expected) || !services.dream.print.includes(expected)) {
    return { state: "repair-needed", enabled: true, scheduler, dream, message: "Background automation points to an older Railgun Classic app. Repair it to use this version." };
  }
  return { state: "enabled", enabled: true, scheduler, dream, message: "Scheduled prompts and nightly maintenance run in the background." };
};

const atomicWrite = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

const fileExists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const exec = promisify(execFile);
const launchctl = async (args: readonly string[]): Promise<CommandResult> => {
  try {
    const result = await exec("/bin/launchctl", [...args], { encoding: "utf8" });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

export const createBackgroundAutomationService = (runtime: AutomationRuntime, dependencies: AutomationDependencies = {}) => {
  const paths = automationLaunchAgentPaths(runtime.home);
  const writeAtomic = dependencies.writeAtomic ?? atomicWrite;
  const exists = dependencies.exists ?? fileExists;
  const run = dependencies.run ?? launchctl;
  const remove = dependencies.remove ?? (async (path: string): Promise<void> => { await rm(path, { force: true }); });
  const print = async (label: string): Promise<string | undefined> => {
    const result = await run(["print", `gui/${runtime.uid}/${label}`]);
    return result.status === 0 ? result.stdout : undefined;
  };
  const getAutomationStatus = async (): Promise<AutomationStatus> => parseAutomationStatus({
    scheduler: { file: await exists(paths.scheduler), print: await print(AUTOMATION_LABELS.scheduler) },
    dream: { file: await exists(paths.dream), print: await print(AUTOMATION_LABELS.dream) },
  }, runtime);
  const replace = async (): Promise<AutomationStatus> => {
    await Promise.all([
      writeAtomic(paths.scheduler, makeAutomationPlist("scheduler", runtime)),
      writeAtomic(paths.dream, makeAutomationPlist("dream", runtime)),
    ]);
    for (const args of launchctlCommands("enable", runtime.uid, paths)) {
      const result = await run(args);
      if (args[0] !== "bootout" && result.status !== 0) throw new Error(result.stderr || `launchctl ${args.join(" ")} failed`);
    }
    return getAutomationStatus();
  };
  return {
    getAutomationStatus,
    enableAutomation: replace,
    repairAutomation: replace,
    disableAutomation: async (): Promise<AutomationStatus> => {
      for (const args of launchctlCommands("disable", runtime.uid, paths)) await run(args);
      await Promise.all([remove(paths.scheduler), remove(paths.dream)]);
      return getAutomationStatus();
    },
  };
};
