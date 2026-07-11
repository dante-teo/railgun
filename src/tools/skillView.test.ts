import { describe, expect, it, beforeEach } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./skillView.js";
import { setSkillIndex } from "./skillView.js";
import type { SkillMeta } from "../skills.js";

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
    const index = new Map<string, SkillMeta>([
      ["git-helper", makeSkill("git-helper", "Use conventional commits.")],
    ]);
    setSkillIndex(index);
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
});
