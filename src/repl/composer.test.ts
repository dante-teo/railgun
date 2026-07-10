import { describe, expect, it } from "vitest";
import { composerRows, enhancedKeyboardMode, interpretComposerKey, preserveDraft, replaceComposerDraft, sanitizeComposerInput, shouldHandleComposerEvent } from "./composer.js";

describe("composer helpers", () => {
  it("grows from one to six wrapped rows and caps further in short terminals", () => {
    expect(composerRows("", 80, 30)).toBe(1);
    expect(composerRows("a\nb\nc", 80, 30)).toBe(3);
    expect(composerRows("x".repeat(200), 20, 30)).toBe(6);
    expect(composerRows("a\nb\nc\nd", 80, 10)).toBe(2);
  });

  it("maps Enter, Shift+Enter, and Tab to explicit actions", () => {
    expect(interpretComposerKey({ return: true, shift: false, tab: false }, true)).toEqual({ type: "submit" });
    expect(interpretComposerKey({ return: true, shift: true, tab: false }, true)).toEqual({ type: "newline" });
    expect(interpretComposerKey({ return: false, shift: false, tab: true }, true)).toEqual({ type: "complete" });
    expect(interpretComposerKey({ return: false, shift: false, tab: true }, false)).toEqual({ type: "enqueue-placeholder" });
  });

  it("preserves multiline paste and drafts while disabled", () => {
    expect(preserveDraft("one\ntwo", "one\ntwo", true)).toBe("one\ntwo");
    expect(preserveDraft("draft", "ignored", false)).toBe("draft");
  });

  it("handles each physical key once and supports the macOS Ctrl+U editing convention", () => {
    expect(shouldHandleComposerEvent(undefined)).toBe(true);
    expect(shouldHandleComposerEvent("press")).toBe(true);
    expect(shouldHandleComposerEvent("repeat")).toBe(true);
    expect(shouldHandleComposerEvent("release")).toBe(false);
  });

  it("enables enhanced reporting without a capability query only in known supporting terminals", () => {
    expect(enhancedKeyboardMode({ TERM_PROGRAM: "ghostty" })).toBe("enabled");
    expect(enhancedKeyboardMode({ TERM_PROGRAM: "Apple_Terminal" })).toBe("disabled");
  });

  it("removes theme and keyboard protocol replies without changing normal text or paste", () => {
    expect(sanitizeComposerInput("[?2031;1$y")).toBe("");
    expect(sanitizeComposerInput("]11;rgb:1111/2222/3333\u0007")).toBe("");
    expect(sanitizeComposerInput("[?1u")).toBe("");
    expect(sanitizeComposerInput("[<64;20;8M")).toBe("");
    expect(sanitizeComposerInput("one\ntwo")).toBe("one\ntwo");
  });

  it("advances the editor revision when completion replaces the draft so its cursor resets to the end", () => {
    expect(replaceComposerDraft("/ex", "/exit ", 2)).toEqual({ draft: "/exit ", revision: 3 });
    expect(replaceComposerDraft("draft", null, 2)).toEqual({ draft: "draft", revision: 2 });
  });
});
