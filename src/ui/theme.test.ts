import { describe, it, expect } from "vitest";
import { createAnsiTheme } from "./theme.js";
import { palettes, glyphs } from "./palette.js";

describe("palettes", () => {
  it("dark accent is a valid #RRGGBB hex string", () => {
    expect(palettes.dark.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("all palette fields are valid #RRGGBB hex strings", () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    for (const mode of ["dark", "light"] as const) {
      for (const [key, value] of Object.entries(palettes[mode])) {
        expect(value, `palettes.${mode}.${key}`).toMatch(hexPattern);
      }
    }
  });

  it("palettes is JSON-serializable", () => {
    const roundtripped = JSON.parse(JSON.stringify(palettes));
    expect(roundtripped.dark.accent).toBe(palettes.dark.accent);
    expect(roundtripped.light.accent).toBe(palettes.light.accent);
  });

  it("dark and light palettes have different accent values", () => {
    expect(palettes.dark.accent).not.toBe(palettes.light.accent);
  });
});

describe("glyphs", () => {
  it("contains expected tool state glyphs", () => {
    expect(glyphs.toolRunning).toBe("⏺");
    expect(glyphs.toolDone).toBe("✔");
    expect(glyphs.toolError).toBe("✘");
  });

  it("contains streaming cursor glyph", () => {
    expect(glyphs.streamingCursor).toBe("▌");
  });

  it("contains unseen messages glyph", () => {
    expect(glyphs.unseenMessages).toBe("↓");
  });
});

describe("createAnsiTheme", () => {
  it("returns mode === 'dark' for dark mode", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.mode).toBe("dark");
  });

  it("returns mode === 'light' for light mode", () => {
    const theme = createAnsiTheme("light");
    expect(theme.mode).toBe("light");
  });

  it("defaults to dark mode", () => {
    const theme = createAnsiTheme();
    expect(theme.mode).toBe("dark");
  });

  it("accent wraps text in ANSI truecolor fg escape and reset", () => {
    const theme = createAnsiTheme("dark");
    const result = theme.accent("hello");
    expect(result).toContain("hello");
    expect(result).toMatch(/^\u001b\[38;2;/);
    expect(result).toMatch(/\u001b\[0m$/);
  });

  it("accent uses dark palette RGB values", () => {
    const theme = createAnsiTheme("dark");
    // dark accent is #5EE6B8 → 94,230,184
    const result = theme.accent("x");
    expect(result).toContain("\u001b[38;2;94;230;184m");
  });

  it("light theme uses different escape codes than dark for accent", () => {
    const dark = createAnsiTheme("dark");
    const light = createAnsiTheme("light");
    const darkResult = dark.accent("x");
    const lightResult = light.accent("x");
    // same text, different color sequences
    expect(darkResult).not.toBe(lightResult);
    expect(darkResult).toContain("\u001b[38;2;");
    expect(lightResult).toContain("\u001b[38;2;");
  });

  it("toolCallLabel 'running' contains 'Running' and 'read_file(...)'", () => {
    const theme = createAnsiTheme("dark");
    const label = theme.toolCallLabel("read_file", "running");
    expect(label).toContain("Running");
    expect(label).toContain("read_file(...)");
  });

  it("toolCallLabel 'done' contains ✔ and 'done'", () => {
    const theme = createAnsiTheme("dark");
    const label = theme.toolCallLabel("read_file", "done");
    expect(label).toContain("✔");
    expect(label).toContain("done");
  });

  it("toolCallLabel 'error' contains ✘ and 'failed'", () => {
    const theme = createAnsiTheme("dark");
    const label = theme.toolCallLabel("read_file", "error");
    expect(label).toContain("✘");
    expect(label).toContain("failed");
  });

  it("toolCallPrefix 'running' contains ⏺", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.toolCallPrefix("running")).toContain("⏺");
  });

  it("toolCallPrefix 'done' contains ✔", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.toolCallPrefix("done")).toContain("✔");
  });

  it("toolCallPrefix 'error' contains ✘", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.toolCallPrefix("error")).toContain("✘");
  });

  it("streamingCursor contains ▌", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.streamingCursor()).toContain("▌");
  });

  it("thinkingIndicator contains 'Thinking...'", () => {
    const theme = createAnsiTheme("dark");
    expect(theme.thinkingIndicator()).toContain("Thinking...");
  });

  it("unseenPill contains ↓ and 'new messages'", () => {
    const theme = createAnsiTheme("dark");
    const pill = theme.unseenPill();
    expect(pill).toContain("↓");
    expect(pill).toContain("new messages");
  });

  it("all style functions wrap with ANSI escape start and RESET end", () => {
    const theme = createAnsiTheme("dark");
    const stylers = [
      theme.accent,
      theme.strong,
      theme.text,
      theme.muted,
      theme.dim,
      theme.error,
      theme.success,
      theme.warning,
    ];
    for (const fn of stylers) {
      const result = fn("test");
      expect(result, fn.toString()).toMatch(/^\u001b\[/);
      expect(result, fn.toString()).toMatch(/\u001b\[0m$/);
    }
  });

  it("bgSurface applies background (48;2) escape", () => {
    const theme = createAnsiTheme("dark");
    const result = theme.bgSurface("content");
    expect(result).toContain("\u001b[48;2;");
    expect(result).toContain("content");
    expect(result).toMatch(/\u001b\[0m$/);
  });
});
