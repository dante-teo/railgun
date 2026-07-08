import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpinner } from "./spinner.js";

describe("startSpinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a \\r-prefixed frame+label to stderr on each 80ms tick", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      startSpinner("Reading foo.txt");

      vi.advanceTimersByTime(80);
      expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r⠋ Reading foo.txt");

      vi.advanceTimersByTime(80);
      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(writeSpy).toHaveBeenNthCalledWith(2, "\r⠙ Reading foo.txt");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("stopping with false clears the interval and writes a final checkmark line", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const stop = startSpinner("Reading foo.txt");
      vi.advanceTimersByTime(80);
      writeSpy.mockClear();

      stop(false);
      expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r✓ Reading foo.txt\n");

      writeSpy.mockClear();
      vi.advanceTimersByTime(240);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("stopping with true writes a final cross-mark line instead", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const stop = startSpinner("Running sleep 2");
      stop(true);

      expect(writeSpy).toHaveBeenCalledExactlyOnceWith("\r✗ Running sleep 2\n");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
