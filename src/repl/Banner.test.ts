import { describe, expect, it, vi } from "vitest";
import { printBanner } from "./Banner.js";
import { DEFAULT_SKIN, BUILTIN_SKINS } from "../skins.js";

const collectBanner = (skin: Parameters<typeof printBanner>[0]): string[] => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  printBanner(skin);
  const calls = spy.mock.calls.map(([arg]) => String(arg));
  spy.mockRestore();
  return calls;
};

describe("printBanner", () => {
  it("uses rounded corners for the default skin", () => {
    const lines = collectBanner(DEFAULT_SKIN);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    expect(lines[3]).toContain("╰");
    expect(lines[3]).toContain("╯");
    // No sharp corners
    expect(lines[0]).not.toContain("┌");
    expect(lines[0]).not.toContain("┐");
    expect(lines[3]).not.toContain("└");
    expect(lines[3]).not.toContain("┘");
  });

  it("colors border with skin.colors.border ANSI sequence", () => {
    const lines = collectBanner(DEFAULT_SKIN);
    // #3d424a → rgb(61, 66, 74) → \x1b[38;2;61;66;74m
    const borderAnsi = "\x1b[38;2;61;66;74m";
    expect(lines[0]).toContain(borderAnsi);
  });

  it("colors agent name with skin.colors.accent ANSI sequence (bold)", () => {
    const lines = collectBanner(DEFAULT_SKIN);
    // #febc38 → rgb(254, 188, 56) → \x1b[38;2;254;188;56m
    const accentAnsi = "\x1b[38;2;254;188;56m";
    expect(lines[1]).toContain(accentAnsi);
    expect(lines[1]).toContain("\x1b[1m"); // bold
    expect(lines[1]).toContain("Railgun");
  });

  it("colors welcome text with skin.colors.muted ANSI sequence", () => {
    const lines = collectBanner(DEFAULT_SKIN);
    // #777d88 → rgb(119, 125, 136) → \x1b[38;2;119;125;136m
    const mutedAnsi = "\x1b[38;2;119;125;136m";
    expect(lines[2]).toContain(mutedAnsi);
    expect(lines[2]).toContain("Welcome back.");
  });

  it("uses mono skin colors when given the mono skin", () => {
    const mono = BUILTIN_SKINS["mono"]!;
    const lines = collectBanner(mono);
    // mono border #3a3a3a → rgb(58, 58, 58)
    expect(lines[0]).toContain("\x1b[38;2;58;58;58m");
    // mono accent #5fafaf → rgb(95, 175, 175)
    expect(lines[1]).toContain("\x1b[38;2;95;175;175m");
    // mono muted #8a8a8a → rgb(138, 138, 138)
    expect(lines[2]).toContain("\x1b[38;2;138;138;138m");
    expect(lines[2]).toContain("Ready.");
    // Still rounded corners
    expect(lines[0]).toContain("╭");
    expect(lines[3]).toContain("╰");
  });
});
