import { describe, expect, it } from "vitest";
import {
  toolLineIcon,
  toolLineColor,
  busyColor,
  busySpinnerType,
  approvalColor,
  selectedItemStyle,
  unselectedItemColor,
  toolFrameBg,
  toolFrameBorder,
} from "./toolLineStyle.js";
import { DEFAULT_SKIN, BUILTIN_SKINS } from "../skins.js";

const mono = BUILTIN_SKINS["mono"]!;

describe("toolLineIcon", () => {
  it("returns ✔ for success", () => {
    expect(toolLineIcon(false)).toBe("✔");
  });

  it("returns ✘ for failure", () => {
    expect(toolLineIcon(true)).toBe("✘");
  });
});

describe("toolLineColor", () => {
  it("returns skin success color when not failed", () => {
    expect(toolLineColor(DEFAULT_SKIN, false)).toBe("#89d281");
    expect(toolLineColor(mono, false)).toBe("#558a55");
  });

  it("returns skin error color when failed", () => {
    expect(toolLineColor(DEFAULT_SKIN, true)).toBe("#fc3a4b");
    expect(toolLineColor(mono, true)).toBe("#8a5555");
  });
});

describe("busyColor", () => {
  it("returns skin accent color", () => {
    expect(busyColor(DEFAULT_SKIN)).toBe("#febc38");
    expect(busyColor(mono)).toBe("#5fafaf");
  });
});

describe("busySpinnerType", () => {
  it("returns dots2 (OMP status spinner)", () => {
    expect(busySpinnerType()).toBe("dots2");
  });
});

describe("approvalColor", () => {
  it("returns skin accent color", () => {
    expect(approvalColor(DEFAULT_SKIN)).toBe("#febc38");
    expect(approvalColor(mono)).toBe("#5fafaf");
  });
});

describe("selectedItemStyle", () => {
  it("returns accent foreground and selectedBg background for default skin", () => {
    const style = selectedItemStyle(DEFAULT_SKIN);
    expect(style.color).toBe("#febc38");
    expect(style.backgroundColor).toBe("#31363f");
  });

  it("returns accent foreground and selectedBg background for mono skin", () => {
    const style = selectedItemStyle(mono);
    expect(style.color).toBe("#5fafaf");
    expect(style.backgroundColor).toBe("#3a3a3a");
  });
});

describe("unselectedItemColor", () => {
  it("returns skin dim color for default skin", () => {
    expect(unselectedItemColor(DEFAULT_SKIN)).toBe("#5f6673");
  });

  it("returns skin dim color for mono skin", () => {
    expect(unselectedItemColor(mono)).toBe("#707070");
  });
});

describe("toolFrameBg", () => {
  it("returns toolPendingBg for pending state", () => {
    expect(toolFrameBg(DEFAULT_SKIN, "pending")).toBe("#2a2620");
    expect(toolFrameBg(mono, "pending")).toBe("#333333");
  });

  it("returns toolSuccessBg for success state", () => {
    expect(toolFrameBg(DEFAULT_SKIN, "success")).toBe("#1f2d22");
    expect(toolFrameBg(mono, "success")).toBe("#2a3a2a");
  });

  it("returns toolErrorBg for error state", () => {
    expect(toolFrameBg(DEFAULT_SKIN, "error")).toBe("#2d1f22");
    expect(toolFrameBg(mono, "error")).toBe("#3a2a2a");
  });
});

describe("toolFrameBorder", () => {
  it("returns border color for pending state", () => {
    expect(toolFrameBorder(DEFAULT_SKIN, "pending")).toBe("#3d424a");
    expect(toolFrameBorder(mono, "pending")).toBe("#3a3a3a");
  });

  it("returns success color for success state", () => {
    expect(toolFrameBorder(DEFAULT_SKIN, "success")).toBe("#89d281");
    expect(toolFrameBorder(mono, "success")).toBe("#558a55");
  });

  it("returns error color for error state", () => {
    expect(toolFrameBorder(DEFAULT_SKIN, "error")).toBe("#fc3a4b");
    expect(toolFrameBorder(mono, "error")).toBe("#8a5555");
  });
});
