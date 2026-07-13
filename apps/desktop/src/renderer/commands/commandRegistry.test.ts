import { describe, expect, it } from "vitest";
import { commandFromKeyboardEvent } from "./commandRegistry";

const keyboardEvent = (key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) => ({
  key,
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  altKey: modifiers.altKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
});

describe("renderer command shortcuts", () => {
  it.each([
    [keyboardEvent("n", { metaKey: true }), "new-chat"],
    [keyboardEvent("K", { metaKey: true }), "command-palette"],
    [keyboardEvent("1", { metaKey: true }), "show-chat"],
    [keyboardEvent(",", { metaKey: true }), "show-settings"],
    [keyboardEvent("s", { metaKey: true, ctrlKey: true }), "toggle-sidebar"],
  ] as const)("maps a supported shortcut to %s", (event, command) => {
    expect(commandFromKeyboardEvent(event, "macos")).toBe(command);
  });

  it("does not intercept macOS Control editing shortcuts", () => {
    expect(commandFromKeyboardEvent(keyboardEvent("n", { ctrlKey: true }), "macos")).toBeUndefined();
    expect(commandFromKeyboardEvent(keyboardEvent("k", { ctrlKey: true }), "macos")).toBeUndefined();
  });

  it("uses Control as the primary modifier on other platforms", () => {
    expect(commandFromKeyboardEvent(keyboardEvent("n", { ctrlKey: true }), "other")).toBe("new-chat");
    expect(commandFromKeyboardEvent(keyboardEvent("s", { ctrlKey: true }), "other")).toBe("toggle-sidebar");
    expect(commandFromKeyboardEvent(keyboardEvent("n", { metaKey: true }), "other")).toBeUndefined();
  });

  it("ignores unmodified, alternate, shifted, and unknown shortcuts", () => {
    expect(commandFromKeyboardEvent(keyboardEvent("k"), "macos")).toBeUndefined();
    expect(commandFromKeyboardEvent(keyboardEvent("k", { metaKey: true, altKey: true }), "macos")).toBeUndefined();
    expect(commandFromKeyboardEvent(keyboardEvent("k", { metaKey: true, shiftKey: true }), "macos")).toBeUndefined();
    expect(commandFromKeyboardEvent(keyboardEvent("x", { metaKey: true }), "macos")).toBeUndefined();
  });
});
