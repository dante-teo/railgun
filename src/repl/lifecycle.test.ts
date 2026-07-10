import { describe, expect, it, vi } from "vitest";
import { runInAlternateScreen, runWithMouseTracking, shouldUseAlternateScreen } from "./lifecycle.js";

describe("alternate screen lifecycle", () => {
  it("enters and leaves for interactive TTY output", async () => {
    const write = vi.fn();
    await runInAlternateScreen(write, true, async () => undefined);
    expect(write.mock.calls.map(call => call[0])).toEqual(["\u001b[?1049h", "\u001b[?1049l"]);
  });

  it("always restores after errors and skips screen readers/non-TTYs", async () => {
    const write = vi.fn();
    await expect(runInAlternateScreen(write, true, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(write).toHaveBeenLastCalledWith("\u001b[?1049l");
    expect(shouldUseAlternateScreen(true, false)).toBe(true);
    expect(shouldUseAlternateScreen(true, true)).toBe(false);
    expect(shouldUseAlternateScreen(false, false)).toBe(false);
  });
});

describe("mouse tracking lifecycle", () => {
  it("enables SGR wheel events and always disables them after errors", async () => {
    const write = vi.fn();
    await expect(runWithMouseTracking(write, true, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(write.mock.calls.map(call => call[0])).toEqual([
      "\u001b[?1000h\u001b[?1006h",
      "\u001b[?1006l\u001b[?1000l",
    ]);
  });
});
