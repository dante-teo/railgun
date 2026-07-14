import { describe, expect, it } from "vitest";
import { shouldOverlayInspector } from "./inspectorLayout";

describe("shouldOverlayInspector", () => {
  it("uses the actual remaining transcript width with an expanded sidebar", () => {
    expect(shouldOverlayInspector({ shellWidth: 1_213, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320, workspaceVisible: false })).toBe(true);
    expect(shouldOverlayInspector({ shellWidth: 1_214, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320, workspaceVisible: false })).toBe(false);
  });

  it("accounts for the released sidebar reservation when collapsed", () => {
    expect(shouldOverlayInspector({ shellWidth: 900, sidebarVisible: false, sidebarWidth: 360, inspectorWidth: 320, workspaceVisible: false })).toBe(true);
    expect(shouldOverlayInspector({ shellWidth: 960, sidebarVisible: false, sidebarWidth: 360, inspectorWidth: 320, workspaceVisible: false })).toBe(false);
  });

  it("includes the responsive Files pane reservation", () => {
    expect(shouldOverlayInspector({ shellWidth: 1_885, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320, workspaceVisible: true })).toBe(true);
    expect(shouldOverlayInspector({ shellWidth: 1_886, sidebarVisible: true, sidebarWidth: 238, inspectorWidth: 320, workspaceVisible: true })).toBe(false);
  });
});
