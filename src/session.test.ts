import { describe, expect, it } from "vitest";
import { formatLocalDate } from "./session.js";

describe("formatLocalDate", () => {
  it("uses the host local date fields instead of UTC serialization", () => {
    const localDate = new Date(2026, 6, 9, 0, 30);

    expect(formatLocalDate(localDate)).toBe("2026-07-09");
  });
});
