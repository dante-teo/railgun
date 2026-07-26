import { realpathSync } from "node:fs";

export const isEntryPoint = (entryPath: string | undefined, modulePath: string): boolean => {
  if (entryPath === undefined) return false;
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
};
