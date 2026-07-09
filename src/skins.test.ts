import { describe, expect, it } from "vitest";
import { resolveSkin, BUILTIN_SKINS, DEFAULT_SKIN_NAME } from "./skins.js";

describe("resolveSkin", () => {
  it("returns the default SkinConfig for 'default'", () => {
    const skin = resolveSkin("default");
    expect(skin).toBeDefined();
    expect(skin!.name).toBe("default");
    expect(skin!.colors.accent).toBe("#febc38");
    expect(skin!.colors.border).toBe("#3d424a");
    expect(skin!.colors.muted).toBe("#777d88");
    expect(skin!.colors.dim).toBe("#5f6673");
    expect(skin!.colors.success).toBe("#89d281");
    expect(skin!.colors.error).toBe("#fc3a4b");
    expect(skin!.colors.selectedBg).toBe("#31363f");
    expect(skin!.colors.promptSymbol).toBe("❯");
    expect(skin!.colors.userMessageBg).toBe("#2a2f3a");
    expect(skin!.colors.toolPendingBg).toBe("#2a2620");
    expect(skin!.colors.toolSuccessBg).toBe("#1f2d22");
    expect(skin!.colors.toolErrorBg).toBe("#2d1f22");
    expect(skin!.colors.statusLineBg).toBe("#22262c");
    expect(skin!.colors.statusLineModel).toBe("#febc38");
    expect(skin!.colors.statusLinePath).toBe("#777d88");
    expect(skin!.colors.statusLineGitClean).toBe("#89d281");
    expect(skin!.colors.statusLineGitDirty).toBe("#febc38");
    expect(skin!.branding.agentName).toBe("Railgun");
    expect(skin!.branding.welcome).toBe("Welcome back.");
  });

  it("returns the mono SkinConfig for 'mono'", () => {
    const skin = resolveSkin("mono");
    expect(skin).toBeDefined();
    expect(skin!.name).toBe("mono");
    expect(skin!.colors.accent).toBe("#5fafaf");
    expect(skin!.colors.border).toBe("#3a3a3a");
    expect(skin!.colors.muted).toBe("#8a8a8a");
    expect(skin!.colors.dim).toBe("#707070");
    expect(skin!.colors.success).toBe("#558a55");
    expect(skin!.colors.error).toBe("#8a5555");
    expect(skin!.colors.selectedBg).toBe("#3a3a3a");
    expect(skin!.colors.promptSymbol).toBe(">");
    expect(skin!.colors.userMessageBg).toBe("#2e2e2e");
    expect(skin!.colors.toolPendingBg).toBe("#333333");
    expect(skin!.colors.toolSuccessBg).toBe("#2a3a2a");
    expect(skin!.colors.toolErrorBg).toBe("#3a2a2a");
    expect(skin!.colors.statusLineBg).toBe("#2a2a2a");
    expect(skin!.colors.statusLineModel).toBe("#5fafaf");
    expect(skin!.colors.statusLinePath).toBe("#8a8a8a");
    expect(skin!.colors.statusLineGitClean).toBe("#558a55");
    expect(skin!.colors.statusLineGitDirty).toBe("#5fafaf");
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
