import { describe, expect, it } from "vitest";
import { shouldOverlayInspector, shouldOverlayWorkspace } from "./inspectorLayout";

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

describe("shouldOverlayWorkspace", () => {
  it("overlays Files when reserving it would make chat unusably narrow", () => {
    expect(shouldOverlayWorkspace(760, true, 238)).toBe(true);
    expect(shouldOverlayWorkspace(989, true, 238)).toBe(true);
    expect(shouldOverlayWorkspace(990, true, 238)).toBe(false);
    expect(shouldOverlayWorkspace(1_024, true, 238)).toBe(false);
    expect(shouldOverlayWorkspace(1_440, true, 238)).toBe(false);
  });

  it("reserves Files at the window floor when collapsing the sidebar leaves usable chat space", () => {
    expect(shouldOverlayWorkspace(760, false, 360)).toBe(false);
    expect(shouldOverlayWorkspace(900, false, 360)).toBe(false);
  });
});
