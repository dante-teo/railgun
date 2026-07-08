import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSkin, DEFAULT_SKIN_NAME } from "./skins.js";

export const CONFIG_PATH = join(homedir(), ".railgun", "config.json");

export interface RailgunConfig {
  readonly skin: string;
}

const parseSkinName = (raw: unknown): string => {
  if (raw && typeof raw === "object" && "skin" in raw) {
    const { skin } = raw;
    if (typeof skin === "string" && resolveSkin(skin)) {
      return skin;
    }
  }
  return DEFAULT_SKIN_NAME;
};

export const loadConfig = async (): Promise<RailgunConfig> => {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(text);
    return { skin: parseSkinName(parsed) };
  } catch {
    return { skin: DEFAULT_SKIN_NAME };
  }
};

export const saveConfig = async (config: RailgunConfig): Promise<void> => {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
};
