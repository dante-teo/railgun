import { describe, expect, it } from "vitest";
import { matchCommand, parseSlashCommand, findMatches, nextCompletionState, KNOWN_COMMANDS } from "./commands.js";

describe("KNOWN_COMMANDS", () => {
  it("contains the four expected commands", () => {
    expect([...KNOWN_COMMANDS]).toEqual(["/exit", "/skin", "/help", "/clear"]);
  });
});

describe("matchCommand", () => {
  it("returns '/skin' for the unique prefix '/sk'", () => {
    expect(matchCommand("/sk")).toBe("/skin");
  });

  it("returns undefined when prefix matches all commands ('/')", () => {
    expect(matchCommand("/")).toBeUndefined();
  });

  it("returns undefined when prefix matches no commands ('/zz')", () => {
    expect(matchCommand("/zz")).toBeUndefined();
  });

  it("returns the exact command for a full match", () => {
    expect(matchCommand("/help")).toBe("/help");
  });

  it("returns '/clear' for the unique prefix '/cl'", () => {
    expect(matchCommand("/cl")).toBe("/clear");
  });

  it("returns '/exit' for the unique prefix '/e'", () => {
    expect(matchCommand("/e")).toBe("/exit");
  });
});

describe("parseSlashCommand", () => {
  it("splits '/skin mono' into command and arg", () => {
    expect(parseSlashCommand("/skin mono")).toEqual({
      command: "/skin",
      arg: "mono",
    });
  });

  it("returns command only for '/help' (no arg key)", () => {
    const result = parseSlashCommand("/help");
    expect(result.command).toBe("/help");
    expect(result).not.toHaveProperty("arg");
  });

  it("handles '/skin  spaced  arg' by trimming and joining", () => {
    expect(parseSlashCommand("/skin  spaced  arg")).toEqual({
      command: "/skin",
      arg: "spaced  arg",
    });
  });

  it("returns command only for '/exit' (no arg key)", () => {
    const result = parseSlashCommand("/exit");
    expect(result.command).toBe("/exit");
    expect(result).not.toHaveProperty("arg");
  });
});
describe("findMatches", () => {
  it("returns all commands for '/'", () => {
    expect(findMatches("/")).toEqual(["/exit", "/skin", "/help", "/clear"]);
  });

  it("returns ['/skin'] for '/sk'", () => {
    expect(findMatches("/sk")).toEqual(["/skin"]);
  });

  it("returns ['/exit'] for '/e'", () => {
    expect(findMatches("/e")).toEqual(["/exit"]);
  });

  it("returns ['/help'] and ['/clear'] share no prefix beyond /", () => {
    expect(findMatches("/h")).toEqual(["/help"]);
    expect(findMatches("/cl")).toEqual(["/clear"]);
  });

  it("returns empty array for no matches", () => {
    expect(findMatches("/zz")).toEqual([]);
  });

  it("returns exact match as single-element array", () => {
    expect(findMatches("/help")).toEqual(["/help"]);
  });
});

describe("nextCompletionState", () => {
  const allCommands = ["/exit", "/skin", "/help", "/clear"];

  it("opens frozen list on first tab with multiple live matches", () => {
    const result = nextCompletionState([], null, allCommands, "tab");
    expect(result.frozenMatches).toEqual(allCommands);
    expect(result.index).toBeNull();
    expect(result.input).toBeNull();
  });

  it("cycles to first item on tab when frozen list is open", () => {
    const result = nextCompletionState(allCommands, null, ["/exit"], "tab");
    expect(result.frozenMatches).toEqual(allCommands);
    expect(result.index).toBe(0);
    expect(result.input).toBe("/exit");
  });

  it("cycles to next item on subsequent tabs", () => {
    const result = nextCompletionState(allCommands, 0, ["/exit"], "tab");
    expect(result.index).toBe(1);
    expect(result.input).toBe("/skin");
  });

  it("wraps around on last item", () => {
    const result = nextCompletionState(allCommands, 3, ["/clear"], "tab");
    expect(result.index).toBe(0);
    expect(result.input).toBe("/exit");
  });

  it("auto-completes with space for single live match", () => {
    const result = nextCompletionState([], null, ["/skin"], "tab");
    expect(result.frozenMatches).toEqual([]);
    expect(result.index).toBeNull();
    expect(result.input).toBe("/skin ");
  });

  it("clears everything on escape", () => {
    const result = nextCompletionState(allCommands, 2, ["/help"], "escape");
    expect(result.frozenMatches).toEqual([]);
    expect(result.index).toBeNull();
    expect(result.input).toBeNull();
  });

  it("returns empty state on tab with no matches", () => {
    const result = nextCompletionState([], null, [], "tab");
    expect(result.frozenMatches).toEqual([]);
    expect(result.index).toBeNull();
    expect(result.input).toBeNull();
  });
});
