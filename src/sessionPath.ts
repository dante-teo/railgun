import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_PATH = join(homedir(), ".railgun", "devin-token");
