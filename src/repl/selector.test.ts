import { describe, expect, it } from "vitest";
import { createSelectorState, reduceSelector } from "./selector.js";
import type { SelectorState } from "./selector.js";

describe("selector reducer", () => {
  it("initializes the viewport with a later selection visible", () => {
    expect(createSelectorState(12, 4, 9)).toMatchObject({
      selectedIndex: 9,
      scrollOffset: 6,
    });
  });

  it("wraps navigation and keeps the selection visible", () => {
    const initial = createSelectorState(5, 2);
    expect(reduceSelector(initial, { type: "up" })).toMatchObject({ selectedIndex: 4, scrollOffset: 3 });
    expect(reduceSelector(initial, { type: "down" })).toMatchObject({ selectedIndex: 1, scrollOffset: 0 });
  });

  it("is safe for empty lists and records cancellation", () => {
    const initial = createSelectorState(0, 3);
    expect(reduceSelector(initial, { type: "down" })).toEqual(initial);
    expect(reduceSelector(initial, { type: "cancel" }).cancelled).toBe(true);
  });

  it("normalizes negative counts as an empty selector", () => {
    expect(createSelectorState(-2, 0, 4)).toMatchObject({
      itemCount: 0,
      visibleCount: 1,
      selectedIndex: 0,
      scrollOffset: 0,
    });
  });

  it("toggles checkboxes immutably within a configured limit", () => {
    const initial = { ...createSelectorState(9, 4), selectedIndexes: new Set([0]) };
    let state: SelectorState = initial;
    for (let index = 1; index < 8; index += 1) {
      state = { ...state, selectedIndex: index };
      state = reduceSelector(state, { type: "toggle", maxSelected: 8 });
    }
    const unchanged = reduceSelector({ ...state, selectedIndex: 8 }, { type: "toggle", maxSelected: 8 });
    expect(unchanged.selectedIndexes.size).toBe(8);
    expect(initial.selectedIndexes).toEqual(new Set([0]));
  });

  it("requires the minimum checklist count before confirming", () => {
    const empty = createSelectorState(2, 2);
    expect(reduceSelector(empty, { type: "confirm", minSelected: 1 }).confirmed).toBe(false);
    expect(reduceSelector({ ...empty, selectedIndexes: new Set([1]) }, { type: "confirm", minSelected: 1 }).confirmed).toBe(true);
  });
});
