import { readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { SKILLS_PATH } from "./paths.js";

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly disableModelInvocation: boolean;
  readonly loadBody: () => string;
}

const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;

export const splitFrontmatter = (raw: string): { frontmatter: string; body: string } => {
  // Opening fence must be alone on its first line
  const crlf = raw.startsWith("---\r\n");
  if (!crlf && !raw.startsWith("---\n")) {
    return { frontmatter: "", body: raw };
  }
  const fenceEnd = crlf ? 5 : 4; // byte offset past the opening ---\n or ---\r\n
  const bodyStart = raw.indexOf("\n---", 3);
  if (bodyStart === -1) return { frontmatter: "", body: raw };
  const afterClose = raw.slice(bodyStart + 4); // skip \n---
  // Closing --- must be followed by \n, \r\n, or end-of-string
  if (afterClose.length > 0 && afterClose[0] !== "\n" && afterClose[0] !== "\r") {
    return { frontmatter: "", body: raw };
  }
  const frontmatter = raw.slice(fenceEnd, bodyStart);
  const body = afterClose.startsWith("\r\n") ? afterClose.slice(2)
    : afterClose[0] === "\n" ? afterClose.slice(1)
    : afterClose;
  return { frontmatter, body };
};

const escapeXmlAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const parseSkillFile = (filePath: string): SkillMeta | null => {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`[skills] Could not read ${filePath}: ${String(err)}`);
    return null;
  }

  const { frontmatter, body } = splitFrontmatter(raw);

  let meta: Record<string, unknown> = {};
  if (frontmatter) {
    try {
      const parsed: unknown = parseYaml(frontmatter);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch (err) {
      console.warn(`[skills] Failed to parse YAML frontmatter in ${filePath}: ${String(err)}`);
      return null;
    }
  }

  // Derive name
  const base = basename(filePath, ".md");
  const inferredName = base === "SKILL" ? basename(dirname(filePath)) : base;
  const rawName = typeof meta["name"] === "string" ? meta["name"] : inferredName;
  if (!SKILL_NAME_RE.test(rawName)) {
    console.warn(`[skills] Skill at ${filePath} has invalid name "${rawName}" (must match /^[a-z0-9-]{1,64}$/). Skipping.`);
    return null;
  }

  // Validate description
  const rawDescription = meta["description"];
  if (typeof rawDescription !== "string" || rawDescription.trim() === "") {
    console.warn(`[skills] Skill at ${filePath} is missing a non-empty "description". Skipping.`);
    return null;
  }
  if (rawDescription.length > 1024) {
    console.warn(`[skills] Skill at ${filePath} has "description" longer than 1024 chars. Skipping.`);
    return null;
  }

  const disableModelInvocation = meta["disable-model-invocation"] === true;

  return {
    name: rawName,
    description: rawDescription,
    path: filePath,
    disableModelInvocation,
    loadBody: () => body,
  };
};

export const discoverSkills = (dir: string): SkillMeta[] => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  // Skill root: a directory containing SKILL.md — parse it and stop recursing
  if (entries.some(e => e.isFile() && e.name === "SKILL.md")) {
    const parsed = parseSkillFile(join(dir, "SKILL.md"));
    return parsed !== null ? [parsed] : [];
  }

  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      skills.push(...discoverSkills(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const parsed = parseSkillFile(join(dir, entry.name));
      if (parsed !== null) skills.push(parsed);
    }
  }

  return skills;
};

export const buildSkillIndex = (discovered: SkillMeta[]): ReadonlyMap<string, SkillMeta> => {
  const index = new Map<string, SkillMeta>();
  for (const skill of discovered) {
    if (index.has(skill.name)) {
      const existing = index.get(skill.name)!;
      console.warn(`[skills] Duplicate skill name "${skill.name}" found at ${skill.path} (already loaded from ${existing.path}). Skipping later one.`);
      continue;
    }
    index.set(skill.name, skill);
  }
  return index;
};

export const loadSkills = (dir?: string): ReadonlyMap<string, SkillMeta> =>
  buildSkillIndex(discoverSkills(dir ?? SKILLS_PATH));

export const formatSkillsForPrompt = (skills: ReadonlyMap<string, SkillMeta>): string => {
  const visible = [...skills.values()].filter(s => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = visible.map(s => `  <skill name="${escapeXmlAttr(s.name)}" description="${escapeXmlAttr(s.description)}" />`);
  return [
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "",
    "When a task matches one of these skills, read the full instructions by calling skill_view(name). You can create, edit, or delete skills by writing to ~/.railgun/skills/<name>/SKILL.md.",
  ].join("\n");
};

/**
 * Returns base prompt with a freshly-loaded skills block appended.
 * Call once per agent-session start (not at session build time) so skills
 * created mid-session are visible on the next turn without a restart.
 *
 * @param base   The base system prompt array (no skills block baked in).
 * @param dir    Skills directory to scan; defaults to SKILLS_PATH.
 */
export const resolveSystemPrompt = (
  base: readonly string[],
  dir?: string,
): readonly string[] => {
  const skills = loadSkills(dir);
  const block = formatSkillsForPrompt(skills);
  return block ? [...base, block] : base;
};

const SKILL_COMMAND_RE = /^\/skill:([a-z0-9-]+)(?:\s+(.*))?$/s;

export const expandSkillCommand = (
  input: string,
  index: ReadonlyMap<string, SkillMeta>,
): { kind: "expanded"; content: string } | { kind: "error"; message: string } | null => {
  const match = SKILL_COMMAND_RE.exec(input);
  if (!match) return null;
  const name = match[1]!;
  const args = match[2]?.trim() ?? "";
  const skill = index.get(name);
  if (!skill) {
    return { kind: "error", message: `Unknown skill: ${name}` };
  }
  const body = skill.loadBody();
  const content = [
    `<skill name="${escapeXmlAttr(skill.name)}" location="${escapeXmlAttr(skill.path)}">`,
    body,
    `</skill>`,
    ...(args ? [args] : []),
  ].join("\n").trim();
  return { kind: "expanded", content };
};
