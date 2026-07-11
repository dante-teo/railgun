import { describe, expect, it } from "vitest";
import {
  CONFIG_PATH,
  SOUL_PATH,
  STATE_PATH,
  TOKEN_PATH,
  TRUST_PATH,
  getHomeDir,
  pathsForHome,
} from "./paths.js";

describe("application paths", () => {
  it("derives every application file from the single Railgun home", () => {
    expect(pathsForHome("/home/test/.railgun")).toEqual({
      config: "/home/test/.railgun/config.json",
      token: "/home/test/.railgun/devin-token",
      state: "/home/test/.railgun/state.db",
      soul: "/home/test/.railgun/SOUL.md",
      trust: "/home/test/.railgun/trust.json",
    });
    expect({ config: CONFIG_PATH, token: TOKEN_PATH, state: STATE_PATH, soul: SOUL_PATH, trust: TRUST_PATH })
      .toEqual(pathsForHome(getHomeDir()));
  });
});
