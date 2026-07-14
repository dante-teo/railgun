import { describe, expect, it } from "vitest";
import { normalizeCronSchedule, parseCronSchedule } from "./cron";

describe("desktop cron schedules", () => {
  it("normalizes whitespace and requires exactly five fields", () => {
    expect(normalizeCronSchedule("  0\t9   * * 1-5  ")).toBe("0 9 * * 1-5");
    expect(parseCronSchedule("0 9 * * 1-5")).toMatchObject({ valid: true, schedule: "0 9 * * 1-5" });
    expect(parseCronSchedule("0 0 9 * * 1-5")).toMatchObject({ valid: false, error: expect.stringContaining("five fields") });
    expect(parseCronSchedule("@daily")).toMatchObject({ valid: false });
  });

  it("rejects invalid syntax and ranges", () => {
    for (const schedule of ["61 * * * *", "0 25 * * *", "0 9 0 * *", "0 9 * FUNDAY *", "*/0 * * * *"]) {
      expect(parseCronSchedule(schedule)).toMatchObject({ valid: false });
    }
  });

  it("accepts named fields, steps, and ranges with readable summaries", () => {
    const named = parseCronSchedule("*/15 8-17 * JAN,MAR MON-FRI");
    expect(named).toMatchObject({ valid: true, schedule: "*/15 8-17 * JAN,MAR MON-FRI" });
    if (!named.valid) throw new Error(named.error);
    expect(named.summary).toMatch(/15 minutes|January|Monday/iu);
  });
});
