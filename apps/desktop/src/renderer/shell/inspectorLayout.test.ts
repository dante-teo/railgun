import { describe, expect, it } from "vitest";
import { shouldOverlayInspector } from "./inspectorLayout";

describe("shouldOverlayInspector", () => {
  it("uses the actual remaining transcript width with an expanded sidebar", () => {
    expect(shouldOverlayInspector({ shellWidth: 1_200, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320 })).toBe(true);
    expect(shouldOverlayInspector({ shellWidth: 1_216, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320 })).toBe(false);
  });

  it("accounts for the released sidebar reservation when collapsed", () => {
    expect(shouldOverlayInspector({ shellWidth: 900, sidebarVisible: false, sidebarWidth: 360, inspectorWidth: 320 })).toBe(true);
    expect(shouldOverlayInspector({ shellWidth: 960, sidebarVisible: false, sidebarWidth: 360, inspectorWidth: 320 })).toBe(false);
  });
});
