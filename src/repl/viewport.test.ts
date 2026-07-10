import { describe, expect, it } from "vitest";
import { createViewport, reduceViewport, visibleViewportRows } from "./viewport.js";

describe("viewport reducer", () => {
  it("starts at the bottom and pages within bounds", () => {
    const initial = createViewport(20, 5);
    expect(initial).toEqual({ totalRows: 20, viewportRows: 5, offset: 15, unseen: 0 });
    expect(reduceViewport(initial, { type: "page-up" }).offset).toBe(10);
    expect(reduceViewport(initial, { type: "home" }).offset).toBe(0);
    expect(reduceViewport(initial, { type: "page-down" }).offset).toBe(15);
  });

  it("auto-follows new output only while at bottom and counts unseen rows otherwise", () => {
    const bottom = createViewport(10, 4);
    expect(reduceViewport(bottom, { type: "content", totalRows: 13 })).toEqual({ totalRows: 13, viewportRows: 4, offset: 9, unseen: 0 });
    const scrolled = reduceViewport(bottom, { type: "page-up" });
    expect(reduceViewport(scrolled, { type: "content", totalRows: 13 })).toMatchObject({ offset: 2, unseen: 3 });
  });

  it("clamps on resize and clears unseen output when returning to bottom", () => {
    const scrolled = { totalRows: 20, viewportRows: 5, offset: 10, unseen: 2 };
    expect(reduceViewport(scrolled, { type: "resize", viewportRows: 15 })).toEqual({ totalRows: 20, viewportRows: 15, offset: 5, unseen: 0 });
    expect(reduceViewport(scrolled, { type: "end" })).toEqual({ totalRows: 20, viewportRows: 5, offset: 15, unseen: 0 });
  });

  it("keeps following the bottom when a resize makes the viewport shorter", () => {
    expect(reduceViewport(createViewport(20, 10), { type: "resize", viewportRows: 5 })).toEqual({
      totalRows: 20,
      viewportRows: 5,
      offset: 15,
      unseen: 0,
    });
  });

  it("reserves one visible row for the unseen-output cue", () => {
    const rows = ["a", "b", "c", "d", "e", "f"];
    expect(visibleViewportRows(rows, { totalRows: 6, viewportRows: 5, offset: 0, unseen: 2 })).toEqual(["a", "b", "c", "d"]);
    expect(visibleViewportRows(rows, { totalRows: 6, viewportRows: 5, offset: 1, unseen: 0 })).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("scrolls by mouse-sized row deltas and clears unseen state at the bottom", () => {
    const initial = createViewport(30, 10);
    const up = reduceViewport(initial, { type: "scroll", delta: -3 });
    expect(up.offset).toBe(17);
    expect(reduceViewport({ ...up, unseen: 2 }, { type: "scroll", delta: 3 })).toMatchObject({ offset: 20, unseen: 0 });
  });
});
