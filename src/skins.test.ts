import { describe, expect, it } from "vitest";
import { resolveSkin, BUILTIN_SKINS, DEFAULT_SKIN_NAME } from "./skins.js";

describe("resolveSkin", () => {
  it("returns the default SkinConfig for 'default'", () => {
    const skin = resolveSkin("default");
    expect(skin).toBeDefined();
    expect(skin!.name).toBe("default");
    expect(skin!.colors.bannerBorder).toBe("#FFD700");
    expect(skin!.colors.promptSymbol).toBe("❯");
    expect(skin!.spinnerType).toBe("dots");
    expect(skin!.branding.agentName).toBe("Railgun");
    expect(skin!.branding.welcome).toBe("Welcome back.");
  });

  it("returns the mono SkinConfig for 'mono'", () => {
    const skin = resolveSkin("mono");
    expect(skin).toBeDefined();
    expect(skin!.name).toBe("mono");
    expect(skin!.colors.bannerBorder).toBe("#888888");
    expect(skin!.colors.promptSymbol).toBe(">");
    expect(skin!.spinnerType).toBe("line");
    expect(skin!.branding.welcome).toBe("Ready.");
  });

  it("returns undefined for a nonexistent skin name", () => {
    expect(resolveSkin("nonexistent")).toBeUndefined();
  });
});

describe("BUILTIN_SKINS", () => {
  it("contains exactly 'default' and 'mono'", () => {
    expect(Object.keys(BUILTIN_SKINS).sort()).toEqual(["default", "mono"]);
  });
});

describe("DEFAULT_SKIN_NAME", () => {
  it("is 'default'", () => {
    expect(DEFAULT_SKIN_NAME).toBe("default");
  });
});
