import { beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./skillView.js";
import type { SkillMeta } from "../skills.js";

vi.mock("../skills.js", () => ({
  loadSkills: vi.fn(),
}));

import { loadSkills } from "../skills.js";

const context: ToolContext = {
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => {
    throw new Error("skill_view must not request shell approval");
  },
};

const makeSkill = (name: string, body: string): SkillMeta => ({
  name,
  description: `${name} description`,
  path: `/skills/${name}/SKILL.md`,
  disableModelInvocation: false,
  loadBody: () => body,
});

describe("skill_view", () => {
  beforeEach(() => {
    vi.mocked(loadSkills).mockReturnValue(
      new Map<string, SkillMeta>([
        ["git-helper", makeSkill("git-helper", "Use conventional commits.")],
      ])
    );
  });

  it("returns the body for a known skill", async () => {
    const result = await registry.run("skill_view", { name: "git-helper" }, context);
    expect(result).toEqual({ content: "Use conventional commits.", isError: false });
  });

  it("returns an error for an unknown skill name", async () => {
    const result = await registry.run("skill_view", { name: "not-a-skill" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not-a-skill");
  });

  it("returns an error when the name argument is missing", async () => {
    const result = await registry.run("skill_view", {}, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("skill_view");
  });

  it("reads skills fresh from loadSkills() on each call, not from a stale snapshot", async () => {
    // First call: only git-helper exists (set in beforeEach)
    const result1 = await registry.run("skill_view", { name: "new-skill" }, context);
    expect(result1.isError).toBe(true); // new-skill not yet present

    // Simulate agent writing a new skill mid-session
    vi.mocked(loadSkills).mockReturnValue(
      new Map<string, SkillMeta>([
        ["git-helper", makeSkill("git-helper", "Use conventional commits.")],
        ["new-skill", makeSkill("new-skill", "Brand new skill body.")],
      ])
    );

    // Second call: new-skill is now found without restart
    const result2 = await registry.run("skill_view", { name: "new-skill" }, context);
    expect(result2.isError).toBe(false);
    expect(result2.content).toBe("Brand new skill body.");
  });
});
