import { describe, expect, it, vi } from "vitest";
import { createDeltaFrameBuffer } from "./streaming";

describe("assistant delta frame buffer", () => {
  it("coalesces rapid deltas into one animation frame and flushes boundaries synchronously", () => {
    let scheduled: FrameRequestCallback | undefined;
    const flush = vi.fn();
    const cancel = vi.fn();
    const buffer = createDeltaFrameBuffer(flush, callback => { scheduled = callback; return 7; }, cancel);
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");
    expect(flush).not.toHaveBeenCalled();
    scheduled?.(16);
    expect(flush).toHaveBeenCalledWith("abc");

    buffer.push("boundary");
    buffer.flush();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(flush).toHaveBeenLastCalledWith("boundary");
  });
});
