// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useComposer } from "./useComposer.js";

describe("useComposer", () => {
  it("1. initial state", () => {
    const { result } = renderHook(() => useComposer());
    expect(result.current.draft).toBe("");
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.completionMatches).toEqual([]);
    expect(result.current.liveMatches).toEqual([]);
  });

  it("2. setDraft('/') populates liveMatches with all 13 commands", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    expect(result.current.liveMatches).toHaveLength(13);
    expect(result.current.liveMatches).toContain("/model");
    expect(result.current.liveMatches).toContain("/cron");
  });

  it("3. setDraft('/m') filters liveMatches to /model and /moa", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/m"); });
    expect(result.current.liveMatches).toEqual(["/model", "/moa"]);
  });

  it("4. handleTab with single match completes with trailing space", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/roll"); });
    act(() => { result.current.handleTab(); });
    expect(result.current.draft).toBe("/rollback ");
    expect(result.current.completionMatches).toEqual([]);
    expect(result.current.completionIndex).toBeNull();
  });

  it("5. handleTab with multiple matches cycles through them", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/m"); });

    // First Tab: freezes matches, index=null, draft unchanged
    act(() => { result.current.handleTab(); });
    expect(result.current.completionMatches).toEqual(["/model", "/moa"]);
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.draft).toBe("/m");

    // Second Tab: index=0, draft=/model
    act(() => { result.current.handleTab(); });
    expect(result.current.completionIndex).toBe(0);
    expect(result.current.draft).toBe("/model");

    // Third Tab: index=1, draft=/moa
    act(() => { result.current.handleTab(); });
    expect(result.current.completionIndex).toBe(1);
    expect(result.current.draft).toBe("/moa");

    // Fourth Tab: wraps to index=0
    act(() => { result.current.handleTab(); });
    expect(result.current.completionIndex).toBe(0);
    expect(result.current.draft).toBe("/model");
  });

  it("6. handleArrowDown with live matches freezes them and sets index=0", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionMatches).toHaveLength(13);
    expect(result.current.completionIndex).toBe(0);
  });

  it("7. handleArrowDown cycles index and wraps", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    // Freeze and go to index 0
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionIndex).toBe(0);

    // Advance to index 12
    for (let i = 1; i <= 12; i++) {
      act(() => { result.current.handleArrowDown(); });
    }
    expect(result.current.completionIndex).toBe(12);

    // Wrap from 12 to 0
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionIndex).toBe(0);
  });

  it("8. handleArrowUp from null sets index to last item", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    act(() => { result.current.handleArrowUp(); });
    expect(result.current.completionMatches).toHaveLength(13);
    expect(result.current.completionIndex).toBe(12);
  });

  it("9. handleArrowUp cycling wraps from 0 to last", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    // Go to index 0
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionIndex).toBe(0);
    // Arrow up from 0 wraps to 12
    act(() => { result.current.handleArrowUp(); });
    expect(result.current.completionIndex).toBe(12);
  });

  it("10. arrow keys with no matches are no-ops", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("hello"); });
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.completionMatches).toEqual([]);
    act(() => { result.current.handleArrowUp(); });
    expect(result.current.completionIndex).toBeNull();
  });

  it("11. handleEscape clears completion first, then clears draft on second call", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/"); });
    act(() => { result.current.handleArrowDown(); });
    expect(result.current.completionIndex).toBe(0);

    // First Escape: clears completion
    act(() => { result.current.handleEscape(); });
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.completionMatches).toEqual([]);
    expect(result.current.draft).toBe("/");

    // Second Escape: clears draft
    act(() => { result.current.handleEscape(); });
    expect(result.current.draft).toBe("");
  });

  it("12. handleCtrlU clears draft and increments composerRevision", () => {
    const { result } = renderHook(() => useComposer());
    act(() => { result.current.setDraft("/model"); });
    act(() => { result.current.handleArrowDown(); });
    const revisionBefore = result.current.composerRevision;

    act(() => { result.current.handleCtrlU(); });
    expect(result.current.draft).toBe("");
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.completionMatches).toEqual([]);
    expect(result.current.composerRevision).toBe(revisionBefore + 1);
  });

  it("13. handleSubmit calls onSubmit with trimmed text and clears draft; empty draft is no-op", () => {
    const { result } = renderHook(() => useComposer());
    const onSubmit = vi.fn();

    // Empty draft — callback not called
    act(() => { result.current.handleSubmit(onSubmit); });
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => { result.current.setDraft("  hello world  "); });
    act(() => { result.current.handleSubmit(onSubmit); });
    expect(onSubmit).toHaveBeenCalledWith("hello world");
    expect(result.current.draft).toBe("");
    expect(result.current.completionIndex).toBeNull();
    expect(result.current.completionMatches).toEqual([]);
  });
});
