import { execPath, pid, ppid, version as nodeVersion } from "node:process";
import { readFileSync } from "node:fs";
import { getHomeDir, pathsForHome } from "./paths.js";

export const RUNTIME_SURFACES = ["interactive", "one-shot", "rpc", "desktop", "acp", "cron"] as const;
export type RuntimeSurface = typeof RUNTIME_SURFACES[number];

export interface RuntimeContext {
  readonly surface: RuntimeSurface;
  readonly home: string;
  readonly paths: ReturnType<typeof pathsForHome>;
  readonly process: {
    readonly pid: number;
    readonly ppid: number;
    readonly execPath: string;
    readonly nodeVersion: string;
    readonly railgunVersion: string;
  };
}

const readRailgunVersion = (): string => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
};

const railgunVersion = readRailgunVersion();

export const createRuntimeContext = (
  surface: RuntimeSurface,
  home = getHomeDir(),
): RuntimeContext => ({
  surface,
  home,
  paths: pathsForHome(home),
  process: { pid, ppid, execPath, nodeVersion, railgunVersion },
});
