import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  splitFrontmatter,
  parseSkillFile,
  discoverSkills,
  buildSkillIndex,
  formatSkillsForPrompt,
  expandSkillCommand,
  resolveSystemPrompt,
} from "./skills.js";
import type { SkillMeta } from "./skills.js";

// Helper: create a temp dir + cleanup
const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "railgun-skills-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// ──────────────────────────────────────────────
// splitFrontmatter
// ──────────────────────────────────────────────
describe("splitFrontmatter", () => {
  it("splits a valid LF fence pair into frontmatter and body", () => {
    const raw = "---\nname: test\n---\nHello world";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("name: test");
    expect(body).toBe("Hello world");
  });

  it("splits a valid CRLF fence pair without a leading newline in frontmatter", () => {
    const raw = "---\r\nname: test\r\n---\r\nbody text";
    const { frontmatter, body } = splitFrontmatter(raw);
    // fenceEnd must be 5 (---\r\n), so frontmatter must NOT start with \n
    expect(frontmatter.startsWith("\n")).toBe(false);
    expect(frontmatter).toBe("name: test\r");
    expect(body).toBe("body text");
  });

  it("returns empty frontmatter and full body when there is no opening fence", () => {
    const raw = "Just a plain body with no fence at all.";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("");
    expect(body).toBe(raw);
  });

  it("returns empty frontmatter and full body when closing --- is missing", () => {
    const raw = "---\nname: orphan\nno closing fence here";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("");
    expect(body).toBe(raw);
  });

  it("handles an empty frontmatter section (adjacent fences)", () => {
    const raw = "---\n---\nbody content";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("");
    expect(body).toBe("body content");
  });
});

// ──────────────────────────────────────────────
// parseSkillFile
// ──────────────────────────────────────────────
describe("parseSkillFile", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns a valid SkillMeta for a well-formed file", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "helper.md");
      await writeFile(filePath, [
        "---",
        "name: helper",
        "description: A helpful skill.",
        "---",
        "Do helpful things.",
      ].join("\n"), "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("helper");
      expect(result!.description).toBe("A helpful skill.");
      expect(result!.disableModelInvocation).toBe(false);
      expect(result!.path).toBe(filePath);
      expect(result!.loadBody()).toBe("Do helpful things.");
    });
  });

  it("returns null and warns when description is missing", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "nodesc.md");
      await writeFile(filePath, "---\nname: nodesc\n---\nbody", "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[skills]"));
    });
  });

  it("returns null and warns when name fails regex (uppercase)", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "bad.md");
      await writeFile(filePath, "---\nname: BAD_NAME\ndescription: test\n---\nbody", "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[skills]"));
    });
  });

  it("infers name from parent directory for SKILL.md", async () => {
    await withTempDir(async dir => {
      const skillDir = join(dir, "my-skill");
      await mkdir(skillDir);
      const filePath = join(skillDir, "SKILL.md");
      await writeFile(filePath, "---\ndescription: Inferred name skill.\n---\nbody", "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("my-skill");
    });
  });

  it("infers name from filename for non-SKILL.md files", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "formatter.md");
      await writeFile(filePath, "---\ndescription: Formats code.\n---\nbody", "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("formatter");
    });
  });

  it("respects disable-model-invocation: true", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "secret.md");
      await writeFile(filePath, [
        "---",
        "name: secret",
        "description: Private skill.",
        "disable-model-invocation: true",
        "---",
        "secret body",
      ].join("\n"), "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).not.toBeNull();
      expect(result!.disableModelInvocation).toBe(true);
    });
  });

  it("returns null and warns when description exceeds 1024 chars", async () => {
    await withTempDir(async dir => {
      const filePath = join(dir, "long.md");
      const longDesc = "x".repeat(1025);
      await writeFile(filePath, `---\nname: long\ndescription: ${longDesc}\n---\nbody`, "utf-8");

      const result = parseSkillFile(filePath);
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[skills]"));
    });
  });
});

// ──────────────────────────────────────────────
// discoverSkills
// ──────────────────────────────────────────────
describe("discoverSkills", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns [] for a non-existent directory", () => {
    const result = discoverSkills("/definitely/does/not/exist/skills-dir");
    expect(result).toEqual([]);
  });

  it("stops recursion at a directory containing SKILL.md", async () => {
    await withTempDir(async dir => {
      const skillDir = join(dir, "git-helper");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), [
        "---",
        "name: git-helper",
        "description: Git helper skill.",
        "---",
        "body",
      ].join("\n"), "utf-8");
      // Add a nested .md that must NOT be discovered
      const nested = join(skillDir, "nested");
      await mkdir(nested);
      await writeFile(join(nested, "inner.md"), "---\nname: inner\ndescription: Inner.\n---\nbody", "utf-8");

      const results = discoverSkills(dir);
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("git-helper");
    });
  });

  it("discovers .md files at the top level", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "formatter.md"), "---\nname: formatter\ndescription: Formats.\n---\nbody", "utf-8");
      await writeFile(join(dir, "helper.md"), "---\nname: helper\ndescription: Helps.\n---\nbody", "utf-8");

      const results = discoverSkills(dir);
      expect(results).toHaveLength(2);
      expect(results.map(s => s.name).sort()).toEqual(["formatter", "helper"]);
    });
  });

  it("skips non-.md files", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "readme.txt"), "ignore me", "utf-8");
      await writeFile(join(dir, "data.json"), "{}", "utf-8");
      await writeFile(join(dir, "skill.md"), "---\nname: skill\ndescription: A skill.\n---\nbody", "utf-8");

      const results = discoverSkills(dir);
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("skill");
    });
  });

  it("recursively discovers skills in nested directories without SKILL.md", async () => {
    await withTempDir(async dir => {
      const sub = join(dir, "sub");
      await mkdir(sub);
      await writeFile(join(sub, "deep.md"), "---\nname: deep\ndescription: Deep skill.\n---\nbody", "utf-8");

      const results = discoverSkills(dir);
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("deep");
    });
  });
});

// ──────────────────────────────────────────────
// buildSkillIndex
// ──────────────────────────────────────────────
describe("buildSkillIndex", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  const makeMeta = (name: string, path: string): SkillMeta => ({
    name,
    description: `${name} description`,
    path,
    disableModelInvocation: false,
    loadBody: () => "body",
  });

  it("builds an index from a list of skills", () => {
    const skills = [makeMeta("alpha", "/a.md"), makeMeta("beta", "/b.md")];
    const index = buildSkillIndex(skills);
    expect(index.size).toBe(2);
    expect(index.get("alpha")!.path).toBe("/a.md");
    expect(index.get("beta")!.path).toBe("/b.md");
  });

  it("first-loaded-wins on duplicate names and warns", () => {
    const first = makeMeta("dupe", "/first.md");
    const second = makeMeta("dupe", "/second.md");
    const index = buildSkillIndex([first, second]);
    expect(index.size).toBe(1);
    expect(index.get("dupe")!.path).toBe("/first.md");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[skills]"));
  });
});

// ──────────────────────────────────────────────
// formatSkillsForPrompt
// ──────────────────────────────────────────────
describe("formatSkillsForPrompt", () => {
  const makeMeta = (name: string, disable = false): SkillMeta => ({
    name,
    description: `${name} desc`,
    path: `/${name}.md`,
    disableModelInvocation: disable,
    loadBody: () => "body",
  });

  it("returns empty string when the map is empty", () => {
    expect(formatSkillsForPrompt(new Map())).toBe("");
  });

  it("excludes skills with disableModelInvocation: true", () => {
    const index = new Map<string, SkillMeta>([
      ["visible", makeMeta("visible", false)],
      ["secret", makeMeta("secret", true)],
    ]);
    const result = formatSkillsForPrompt(index);
    expect(result).toContain("visible");
    expect(result).not.toContain("secret");
  });

  it("returns empty string when all skills are disabled for model invocation", () => {
    const index = new Map<string, SkillMeta>([["hidden", makeMeta("hidden", true)]]);
    expect(formatSkillsForPrompt(index)).toBe("");
  });

  it("formats visible skills as <available_skills> XML block with management hint", () => {
    const index = new Map<string, SkillMeta>([["formatter", makeMeta("formatter", false)]]);
    const result = formatSkillsForPrompt(index);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
    expect(result).toContain('name="formatter"');
    expect(result).toContain("skill_view(name)");
    expect(result).toContain("create, edit, or delete skills");
  });

  it("escapes XML-special characters in description", () => {
    const skill: SkillMeta = {
      name: "escaper",
      description: 'He said "hello" & <goodbye>',
      path: "/escaper.md",
      disableModelInvocation: false,
      loadBody: () => "body",
    };
    const result = formatSkillsForPrompt(new Map([["escaper", skill]]));
    expect(result).toContain("&quot;hello&quot;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;goodbye&gt;");
    expect(result).not.toContain('"hello"');
  });
});

// ──────────────────────────────────────────────
// expandSkillCommand
// ──────────────────────────────────────────────
describe("expandSkillCommand", () => {
  const makeMeta = (name: string): SkillMeta => ({
    name,
    description: "test",
    path: `/skills/${name}/SKILL.md`,
    disableModelInvocation: false,
    loadBody: () => `Instructions for ${name}.`,
  });

  const index = new Map<string, SkillMeta>([["git-helper", makeMeta("git-helper")]]);

  it("returns null for input not matching the /skill: pattern", () => {
    expect(expandSkillCommand("/help", index)).toBeNull();
    expect(expandSkillCommand("just some text", index)).toBeNull();
    expect(expandSkillCommand("/skill", index)).toBeNull(); // no colon
  });

  it("returns an error-kind result for an unrecognized skill name", () => {
    const result = expandSkillCommand("/skill:unknown", index);
    expect(result?.kind).toBe("error");
    if (result?.kind === "error") {
      expect(result.message).toContain("unknown");
    }
  });

  it("expands a known skill with XML and body", () => {
    const result = expandSkillCommand("/skill:git-helper", index);
    expect(result?.kind).toBe("expanded");
    if (result?.kind === "expanded") {
      expect(result.content).toContain('<skill name="git-helper"');
      expect(result.content).toContain("Instructions for git-helper.");
      expect(result.content).toContain("</skill>");
    }
  });

  it("appends trailing args after the </skill> tag", () => {
    const result = expandSkillCommand("/skill:git-helper write a commit for the auth fix", index);
    expect(result?.kind).toBe("expanded");
    if (result?.kind === "expanded") {
      expect(result.content).toContain("write a commit for the auth fix");
      const contentAfterClose = result.content.split("</skill>")[1]!;
      expect(contentAfterClose.trim()).toBe("write a commit for the auth fix");
    }
  });
});

describe("resolveSystemPrompt", () => {
  it("appends skills block to base prompt on each call", async () => {
    await withTempDir(async dir => {
      const skillDir = join(dir, "my-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), [
        "---",
        "name: my-skill",
        "description: Does something useful",
        "---",
        "Skill body here.",
      ].join("\n"));

      const base = ["base prompt line"];
      const resolved = resolveSystemPrompt(base, dir);
      expect(resolved.length).toBeGreaterThan(base.length);
      expect(resolved.join("\n")).toContain("my-skill");
      expect(resolved.join("\n")).toContain("available_skills");
    });
  });

  it("reflects a newly written skill on the next call without restart", async () => {
    await withTempDir(async dir => {
      const base = ["base prompt line"];

      // First call: no skills
      const first = resolveSystemPrompt(base, dir);
      expect(first.join("\n")).not.toContain("available_skills");

      // Agent writes a new skill mid-session
      const skillDir = join(dir, "hot-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), [
        "---",
        "name: hot-skill",
        "description: Created mid-session",
        "---",
        "Hot skill body.",
      ].join("\n"));

      // Second call: new skill is visible
      const second = resolveSystemPrompt(base, dir);
      expect(second.join("\n")).toContain("hot-skill");
      expect(second.join("\n")).toContain("available_skills");
    });
  });

  it("returns base prompt unchanged when no skills exist", async () => {
    await withTempDir(async dir => {
      const base = ["base prompt line"];
      const resolved = resolveSystemPrompt(base, dir);
      expect(resolved).toEqual(base);
    });
  });
});
