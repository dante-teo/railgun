import { registry } from "./registry.js";
import type { SkillMeta } from "../skills.js";

let skillIndex: ReadonlyMap<string, SkillMeta> = new Map();

export const setSkillIndex = (index: ReadonlyMap<string, SkillMeta>): void => {
  skillIndex = index;
};

registry.register({
  name: "skill_view",
  toolset: "skills",
  verb: "Loading skill",
  previewArgKey: "name",
  schema: {
    name: "skill_view",
    description: "Read the full instructions for a named skill.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill name to load." } },
      required: ["name"],
    },
  },
  handler: async (args) => {
    const name = typeof args === "object" && args !== null
      ? (args as Record<string, unknown>).name
      : undefined;
    if (typeof name !== "string") {
      return { content: 'Error: skill_view requires a string "name" argument.', isError: true };
    }
    const skill = skillIndex.get(name);
    if (!skill) return { content: `Skill "${name}" not found.`, isError: true };
    return { content: skill.loadBody(), isError: false };
  },
});
