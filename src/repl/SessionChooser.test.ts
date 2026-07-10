import { describe, expect, it } from "vitest";
import { moveSessionSelection, sessionListWindow } from "./SessionChooser.js";

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

describe("sessionListWindow", () => {
  it("tracks selection inside a resize-aware list viewport", () => {
    expect(sessionListWindow(0, 10, 3)).toEqual({ start: 0, end: 3 });
    expect(sessionListWindow(5, 10, 3)).toEqual({ start: 3, end: 6 });
    expect(sessionListWindow(9, 10, 3)).toEqual({ start: 7, end: 10 });
    expect(sessionListWindow(2, 10, 1)).toEqual({ start: 2, end: 3 });
  });
});
