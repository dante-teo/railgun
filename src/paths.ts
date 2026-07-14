import { homedir } from "node:os";
import { join } from "node:path";

export const getHomeDir = (): string => join(homedir(), ".railgun");

export const pathsForHome = (home: string) => ({
  config: join(home, "config.json"),
  token: join(home, "devin-token"),
  state: join(home, "state.db"),
  soul: join(home, "SOUL.md"),
  trust: join(home, "trust.json"),
  extensions: join(home, "extensions"),
  cron: join(home, "cron", "jobs.json"),
  cronLogs: join(home, "cron", "logs"),
  skills: join(home, "skills"),
} as const);

const paths = pathsForHome(getHomeDir());

export const CONFIG_PATH = paths.config;
export const TOKEN_PATH = paths.token;
export const STATE_PATH = paths.state;
export const SOUL_PATH = paths.soul;
export const TRUST_PATH = paths.trust;
export const EXTENSIONS_PATH = paths.extensions;
export const CRON_PATH = paths.cron;
export const SKILLS_PATH = paths.skills;
export const CRON_LOGS_PATH = paths.cronLogs;
