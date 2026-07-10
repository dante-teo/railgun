import { describe, expect, it } from "vitest";
import { moveSessionSelection } from "./SessionChooser.js";

describe("moveSessionSelection", () => {
  it("moves down and wraps from the final session to the first", () => {
    expect(moveSessionSelection(0, 3, "down")).toBe(1);
    expect(moveSessionSelection(2, 3, "down")).toBe(0);
  });

  it("moves up and wraps from the first session to the final session", () => {
    expect(moveSessionSelection(2, 3, "up")).toBe(1);
    expect(moveSessionSelection(0, 3, "up")).toBe(2);
  });

  it("keeps an empty or single-item selection at zero", () => {
    expect(moveSessionSelection(0, 0, "down")).toBe(0);
    expect(moveSessionSelection(0, 1, "up")).toBe(0);
  });
});
