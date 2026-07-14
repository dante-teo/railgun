import { describe, expect, it } from "vitest";
import { initialProgressState, planToolCalls, recordToolResults } from "./progress.js";

const call = (id: string, name: string, arguments_: unknown) => ({ id, name, arguments: arguments_ });

describe("agent progress reducer", () => {
  it("warns after six consecutive searches and resets after another tool category", () => {
    const searches = Array.from({ length: 6 }, (_, i) => call(`${i}`, "web_search", { query: `${i}` }));
    const planned = planToolCalls(initialProgressState(), searches, false);
    expect(planned.decisions.at(-1)?.guidance?.toLowerCase()).toContain("fetch");
    expect(planToolCalls(planned.state, [call("six-more", "web_search", { query: "more" })], false).decisions[0]?.guidance)
      .toBeUndefined();

    const reset = planToolCalls(planned.state, [call("fetch", "web_fetch", { url: "https://example.com" })], false);
    expect(reset.state.consecutiveSearches).toBe(0);
  });

  it("closes cron research after ten searches", () => {
    const searches = Array.from({ length: 11 }, (_, i) => call(`${i}`, "web_search", { query: `${i}` }));
    const planned = planToolCalls(initialProgressState(), searches, true);
    expect(planned.decisions.slice(0, 10).every(decision => decision.allowed)).toBe(true);
    expect(planned.decisions[10]).toMatchObject({ allowed: false });
  });

  it("warns on repeated identical results and blocks after five non-progressing attempts", () => {
    const repeated = call("id", "web_fetch", { url: "https://example.com" });
    const results = Array.from({ length: 5 }).reduce<ReturnType<typeof recordToolResults>[]>((history, _, index) => {
      const planned = planToolCalls(history.at(-1)?.state ?? initialProgressState(), [{ ...repeated, id: `${index}` }], false);
      return [...history, recordToolResults(planned.state, planned.decisions, [{ content: "same", isError: false }])];
    }, []);
    expect(results[1]!.guidance).toContain("repeating");
    const sixth = planToolCalls(results[4]!.state, [{ ...repeated, id: "sixth" }], false);
    expect(sixth.decisions[0]).toMatchObject({ allowed: false });
  });

  it("does not keep warning after the agent changes approach", () => {
    const repeated = call("fetch", "web_fetch", { url: "https://example.com" });
    const afterRepeat = Array.from({ length: 2 }).reduce<ReturnType<typeof recordToolResults>>((progress, _, index) => {
      const planned = planToolCalls(progress.state, [{ ...repeated, id: `${index}` }], false);
      return recordToolResults(planned.state, planned.decisions, [{ content: "same", isError: false }]);
    }, { state: initialProgressState() });
    expect(afterRepeat.guidance).toContain("repeating");

    const changedPlan = planToolCalls(afterRepeat.state, [call("read", "read_file", { path: "/tmp/other" })], false);
    const changed = recordToolResults(changedPlan.state, changedPlan.decisions, [{ content: "different", isError: false }]);
    expect(changed.guidance).toBeUndefined();
  });

  it("preserves declared order when blocking calls in a parallel-safe batch", () => {
    const calls = [
      call("a", "web_search", { query: "a" }),
      call("b", "web_search", { query: "b" }),
      call("c", "web_fetch", { url: "https://example.com" }),
    ];
    const seeded = { ...initialProgressState(), consecutiveSearches: 10 };
    expect(planToolCalls(seeded, calls, true).decisions.map(({ call: item, allowed }) => [item.id, allowed])).toEqual([
      ["a", false], ["b", false], ["c", true],
    ]);
  });
});
