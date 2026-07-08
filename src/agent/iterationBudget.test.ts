import { describe, expect, it } from "vitest";
import { IterationBudget } from "./iterationBudget.js";

describe("IterationBudget", () => {
  it("consumes until the max", () => {
    const budget = IterationBudget.create(2);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
  });

  it("refuses after exhaustion", () => {
    const budget = IterationBudget.create(1);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.consume()).toBe(false);
  });

  it("reports the remaining count without going negative", () => {
    const budget = IterationBudget.create(1);

    expect(budget.remaining()).toBe(1);
    expect(budget.consume()).toBe(true);
    expect(budget.remaining()).toBe(0);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });
});
