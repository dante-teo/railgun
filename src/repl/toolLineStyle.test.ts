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
import { THEMES } from "./theme.js";

describe("toolLineIcon", () => {
  it("returns ✔ for success", () => {
    expect(toolLineIcon(false)).toBe("✔");
  });

  it("returns ✘ for failure", () => {
    expect(toolLineIcon(true)).toBe("✘");
  });
});

describe("toolLineColor", () => {
  it("returns theme success color when not failed", () => {
    expect(toolLineColor(THEMES.dark, false)).toBe("#52D89C");
    expect(toolLineColor(THEMES.light, false)).toBe("#087A52");
  });

  it("returns theme error color when failed", () => {
    expect(toolLineColor(THEMES.dark, true)).toBe("#FF7B86");
    expect(toolLineColor(THEMES.light, true)).toBe("#B42335");
  });
});

describe("busyColor", () => {
  it("returns theme accent color", () => {
    expect(busyColor(THEMES.dark)).toBe("#5EE6B8");
    expect(busyColor(THEMES.light)).toBe("#087F5B");
  });
});

describe("busySpinnerType", () => {
  it("returns dots2 (OMP status spinner)", () => {
    expect(busySpinnerType()).toBe("dots2");
  });
});

describe("approvalColor", () => {
  it("returns theme accent color", () => {
    expect(approvalColor(THEMES.dark)).toBe("#5EE6B8");
    expect(approvalColor(THEMES.light)).toBe("#087F5B");
  });
});

describe("selectedItemStyle", () => {
  it("returns dark accent and selection colors", () => {
    const style = selectedItemStyle(THEMES.dark);
    expect(style.color).toBe("#5EE6B8");
    expect(style.backgroundColor).toBe("#1E5A47");
  });

  it("returns light accent and selection colors", () => {
    const style = selectedItemStyle(THEMES.light);
    expect(style.color).toBe("#087F5B");
    expect(style.backgroundColor).toBe("#C9F1E3");
  });
});

describe("unselectedItemColor", () => {
  it("returns dark theme dim color", () => {
    expect(unselectedItemColor(THEMES.dark)).toBe("#78988E");
  });

  it("returns light theme dim color", () => {
    expect(unselectedItemColor(THEMES.light)).toBe("#67877D");
  });
});

describe("toolFrameBg", () => {
  it("returns toolPendingBg for pending state", () => {
    expect(toolFrameBg(THEMES.dark, "pending")).toBe("#3E341A");
    expect(toolFrameBg(THEMES.light, "pending")).toBe("#FFF3CC");
  });

  it("returns toolSuccessBg for success state", () => {
    expect(toolFrameBg(THEMES.dark, "success")).toBe("#123C2B");
    expect(toolFrameBg(THEMES.light, "success")).toBe("#DDF5E9");
  });

  it("returns toolErrorBg for error state", () => {
    expect(toolFrameBg(THEMES.dark, "error")).toBe("#421F26");
    expect(toolFrameBg(THEMES.light, "error")).toBe("#FDE2E5");
  });
});

describe("toolFrameBorder", () => {
  it("returns border color for pending state", () => {
    expect(toolFrameBorder(THEMES.dark, "pending")).toBe("#3F6F60");
    expect(toolFrameBorder(THEMES.light, "pending")).toBe("#8ABDAC");
  });

  it("returns success color for success state", () => {
    expect(toolFrameBorder(THEMES.dark, "success")).toBe("#52D89C");
    expect(toolFrameBorder(THEMES.light, "success")).toBe("#087A52");
  });

  it("returns error color for error state", () => {
    expect(toolFrameBorder(THEMES.dark, "error")).toBe("#FF7B86");
    expect(toolFrameBorder(THEMES.light, "error")).toBe("#B42335");
  });
});
